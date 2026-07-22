/**
 * Minimal TUI implementation with differential rendering
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { resolveAlefAgentDir } from "./alef-agent-dir.js";
import { type Component, CURSOR_MARKER, isFocusable, type RenderMeta } from "./component.js";
import { isKeyRelease, matchesKey } from "./keys.js";
import { type OverlayAnchor, type OverlayHandle, type OverlayOptions, parseSizeValue } from "./overlay-types.js";
import { traceEvent } from "./trace-bridge.js";
import type { Terminal } from "./terminal.js";
import { deleteKittyImage, getCapabilities, isImageLine, setCellDimensions } from "./terminal-image.js";
import { extractSegments, normalizeTerminalOutput, sliceByColumn, sliceWithWidth, truncateToWidth, visibleWidth } from "./utils.js";

/**
 * Write a timestamped render-debug line to stderr.
 * Only active when ALEF_RENDER_DEBUG=1. Synchronous to avoid corrupting
 * the TUI display during nextTick/doRender.
 */
function renderLog(msg: string): void {
	if (process.env.ALEF_RENDER_DEBUG !== "1") return;
	const line = `${new Date().toISOString()} [render] ${msg}\n`;
	try {
		fs.writeFileSync(2, line);
	} catch {
		// Never crash the TUI over a log write failure.
	}
}

const KITTY_SEQUENCE_PREFIX = "\x1b_G";

/**
 *
 */
function extractKittyImageIds(line: string): number[] {
	const sequenceStart = line.indexOf(KITTY_SEQUENCE_PREFIX);
	if (sequenceStart === -1) return [];

	const paramsStart = sequenceStart + KITTY_SEQUENCE_PREFIX.length;
	const paramsEnd = line.indexOf(";", paramsStart);
	if (paramsEnd === -1) return [];

	const params = line.slice(paramsStart, paramsEnd);
	for (const param of params.split(",")) {
		const [key, value] = param.split("=", 2);
		if (key !== "i") continue;
		const id = Number(value);
		if (Number.isInteger(id) && id > 0 && id <= 0xffffffff) {
			return [id];
		}
	}
	return [];
}

export type { Component, Focusable, RenderMeta, RenderHandle } from "./component.js";
export { CURSOR_MARKER, isFocusable } from "./component.js";
export type { OverlayAnchor, OverlayHandle, OverlayMargin, OverlayOptions, SizeValue } from "./overlay-types.js";
export { visibleWidth };

type InputListenerResult = { consume?: boolean; data?: string } | undefined;
type InputListener = (data: string) => InputListenerResult;

/** Detect Termux environment (Android terminal emulator). */
/** Detect Termux environment (Android terminal emulator). */
function isTermuxSession(): boolean {
	return Boolean(process.env.TERMUX_VERSION);
}

/**
 * Container - a component that contains other components
 */
export class Container implements Component {
	children: Component[] = [];

	addChild(component: Component): void {
		this.children.push(component);
	}

	insertAt(index: number, component: Component): void {
		const i = Math.max(0, Math.min(index, this.children.length));
		this.children.splice(i, 0, component);
	}

	removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index !== -1) {
			this.children.splice(index, 1);
		}
	}

	clear(): void {
		this.children = [];
	}

	invalidate(): void {
		for (const child of this.children) {
			child.invalidate();
		}
	}

	render(width: number): string[] {
		const lines: string[] = [];
		for (const child of this.children) {
			const childLines = child.render(width);
			for (const line of childLines) {
				lines.push(line);
			}
		}
		return lines;
	}
}

/**
 * TUI - Main class for managing terminal UI with differential rendering
 */
export class TUI extends Container {
	public terminal: Terminal;
	private previousLines: string[] = [];
	private previousKittyImageIds = new Set<number>();
	private previousWidth = 0;
	private previousHeight = 0;
	private focusedComponent: Component | null = null;
	private inputListeners = new Set<InputListener>();
	private renderErrorCount = 0;
	private static readonly MAX_RENDER_ERRORS = 5;

	/** Global callback for debug key (Shift+Ctrl+D). Called before input is forwarded to focused component. */
	public onDebug?: () => void;
	/** Called synchronously at the end of stop(). Use instead of monkey-patching stop(). */
	public onStop?: () => void;
	/**
	 * Metadata emitted with every onRender call.
	 * Identifies which doRender branch ran so instrumentation can distinguish
	 * full-clear redraws (potential scrollback duplication) from differential updates.
	 */
	public renderMeta: RenderMeta = {
		renderPath: "none",
		firstChanged: -1,
		prevViewportTop: 0,
		totalLines: 0,
		height: 0,
		ts: 0,
	};
	/** Called after each render with the full rendered frame. Used for debug frame capture (ALEF_DEBUG=1). */
	public onRender?: (frame: string, width: number, height: number) => void;
	/** Called with every raw input byte before any other processing. Return true to consume and stop propagation. */
	public onRawInput?: (data: string) => boolean;
	private renderRequested = false;
	private renderTimer: NodeJS.Timeout | undefined;
	private lastRenderAt = 0;
	private static readonly MIN_RENDER_INTERVAL_MS = 16;
	private cursorRow = 0; // Logical cursor row (end of rendered content)
	private hardwareCursorRow = 0; // Actual terminal cursor row (may differ due to IME positioning)
	private showHardwareCursor = process.env.ALEF_HARDWARE_CURSOR === "1";
	private clearOnShrink = process.env.ALEF_CLEAR_ON_SHRINK === "1"; // Clear empty rows when content shrinks (default: off)
	private maxLinesRendered = 0; // Track terminal's working area (max lines ever rendered)
	private previousViewportTop = 0; // Track previous viewport top for resize-aware cursor moves
	private fullRedrawCount = 0;
	private stopped = false;
	/** First child of the docked bottom band (streaming + input + footer). Null = disabled. */
	private dockFromChild: Component | null = null;
	/** Last scrollable (chat) lines — used to archive into terminal scrollback. */
	private previousScrollable: string[] = [];
	/** Body rows above dock on the previous frame. */
	private previousDockBodyRows = 0;

	// Overlay stack for modal components rendered on top of base content
	private focusOrderCounter = 0;
	private overlayStack: {
		component: Component;
		options?: OverlayOptions;
		preFocus: Component | null;
		hidden: boolean;
		focusOrder: number;
	}[] = [];

	constructor(terminal: Terminal, showHardwareCursor?: boolean) {
		super();
		this.terminal = terminal;
		if (showHardwareCursor !== undefined) {
			this.showHardwareCursor = showHardwareCursor;
		}
	}

	get fullRedraws(): number {
		return this.fullRedrawCount;
	}

	getShowHardwareCursor(): boolean {
		return this.showHardwareCursor;
	}

	setShowHardwareCursor(enabled: boolean): void {
		if (this.showHardwareCursor === enabled) return;
		this.showHardwareCursor = enabled;
		if (!enabled) {
			this.terminal.hideCursor();
		}
		this.requestRender();
	}

	getClearOnShrink(): boolean {
		return this.clearOnShrink;
	}

	/**
	 * Set whether to trigger full re-render when content shrinks.
	 * When true (default), empty rows are cleared when content shrinks.
	 * When false, empty rows remain (reduces redraws on slower terminals).
	 */
	setClearOnShrink(enabled: boolean): void {
		this.clearOnShrink = enabled;
	}

	/**
	 * Pin this child and everything after it to the bottom of the viewport.
	 * Live widgets (plan, tasks, editor, footer) must use this so chat growth
	 * cannot scroll them into terminal scrollback.
	 */
	setDock(component: Component | null): void {
		this.dockFromChild = component;
	}

	setFocus(component: Component | null): void {
		// Clear focused flag on old component
		if (isFocusable(this.focusedComponent)) {
			this.focusedComponent.focused = false;
		}

		this.focusedComponent = component;

		// Set focused flag on new component
		if (isFocusable(component)) {
			component.focused = true;
		}
	}

	/**
	 * Show an overlay component with configurable positioning and sizing.
	 * Returns a handle to control the overlay's visibility.
	 */
	showOverlay(component: Component, options?: OverlayOptions): OverlayHandle {
		const entry = {
			component,
			options,
			preFocus: this.focusedComponent,
			hidden: false,
			focusOrder: ++this.focusOrderCounter,
		};
		this.overlayStack.push(entry);
		// Only focus if overlay is actually visible
		if (!options?.nonCapturing && this.isOverlayVisible(entry)) {
			this.setFocus(component);
		}
		this.terminal.hideCursor();
		this.requestRender();

		// Return handle for controlling this overlay
		return {
			hide: () => {
				const index = this.overlayStack.indexOf(entry);
				if (index !== -1) {
					this.overlayStack.splice(index, 1);
					// Restore focus if this overlay had focus
					if (this.focusedComponent === component) {
						const topVisible = this.getTopmostVisibleOverlay();
						this.setFocus(topVisible?.component ?? entry.preFocus);
					}
					if (this.overlayStack.length === 0) this.terminal.hideCursor();
					this.requestRender();
				}
			},
			setHidden: (hidden: boolean) => {
				if (entry.hidden === hidden) return;
				entry.hidden = hidden;
				// Update focus when hiding/showing
				if (hidden) {
					// If this overlay had focus, move focus to next visible or preFocus
					if (this.focusedComponent === component) {
						const topVisible = this.getTopmostVisibleOverlay();
						this.setFocus(topVisible?.component ?? entry.preFocus);
					}
				} else {
					// Restore focus to this overlay when showing (if it's actually visible)
					if (!options?.nonCapturing && this.isOverlayVisible(entry)) {
						entry.focusOrder = ++this.focusOrderCounter;
						this.setFocus(component);
					}
				}
				this.requestRender();
			},
			isHidden: () => entry.hidden,
			focus: () => {
				if (!this.overlayStack.includes(entry) || !this.isOverlayVisible(entry)) return;
				if (this.focusedComponent !== component) {
					this.setFocus(component);
				}
				entry.focusOrder = ++this.focusOrderCounter;
				this.requestRender();
			},
			unfocus: () => {
				if (this.focusedComponent !== component) return;
				const topVisible = this.getTopmostVisibleOverlay();
				this.setFocus(topVisible && topVisible !== entry ? topVisible.component : entry.preFocus);
				this.requestRender();
			},
			isFocused: () => this.focusedComponent === component,
		};
	}

	/** Hide the topmost overlay and restore previous focus. */
	hideOverlay(): void {
		const overlay = this.overlayStack.pop();
		if (!overlay) return;
		if (this.focusedComponent === overlay.component) {
			// Find topmost visible overlay, or fall back to preFocus
			const topVisible = this.getTopmostVisibleOverlay();
			this.setFocus(topVisible?.component ?? overlay.preFocus);
		}
		if (this.overlayStack.length === 0) this.terminal.hideCursor();
		this.requestRender();
	}

	/** Check if there are any visible overlays */
	hasOverlay(): boolean {
		return this.overlayStack.some((o) => this.isOverlayVisible(o));
	}

	/** Check if an overlay entry is currently visible */
	private isOverlayVisible(entry: (typeof this.overlayStack)[number]): boolean {
		if (entry.hidden) return false;
		if (entry.options?.visible) {
			return entry.options.visible(this.terminal.columns, this.terminal.rows);
		}
		return true;
	}

	/** Find the topmost visible capturing overlay, if any */
	private getTopmostVisibleOverlay(): (typeof this.overlayStack)[number] | undefined {
		for (let i = this.overlayStack.length - 1; i >= 0; i--) {
			if (this.overlayStack[i]!.options?.nonCapturing) continue;
			if (this.isOverlayVisible(this.overlayStack[i]!)) {
				return this.overlayStack[i]!
			}
		}
		return undefined;
	}

	override invalidate(): void {
		super.invalidate();
		for (const overlay of this.overlayStack) overlay.component.invalidate();
	}

	start(): void {
		this.stopped = false;
		this.terminal.start(
			(data) => this.handleInput(data),
			() => this.requestRender(),
		);
		this.terminal.hideCursor();
		this.queryCellSize();
		this.requestRender();
	}

	addInputListener(listener: InputListener): () => void {
		this.inputListeners.add(listener);
		return () => {
			this.inputListeners.delete(listener);
		};
	}

	removeInputListener(listener: InputListener): void {
		this.inputListeners.delete(listener);
	}

	private queryCellSize(): void {
		// Only query if terminal supports images (cell size is only used for image rendering)
		if (!getCapabilities().images) {
			return;
		}
		// Query terminal for cell size in pixels: CSI 16 t
		// Response format: CSI 6 ; height ; width t
		this.terminal.write("\x1b[16t");
	}

	stop(): void {
		this.stopped = true;
		if (this.renderTimer) {
			clearTimeout(this.renderTimer);
			this.renderTimer = undefined;
		}
		// Move cursor to the end of the content to prevent overwriting/artifacts on exit
		if (this.previousLines.length > 0) {
			const targetRow = this.previousLines.length; // Line after the last content
			const lineDiff = targetRow - this.hardwareCursorRow;
			if (lineDiff > 0) {
				this.terminal.write(`\x1b[${lineDiff}B`);
			} else if (lineDiff < 0) {
				this.terminal.write(`\x1b[${-lineDiff}A`);
			}
			this.terminal.write("\r\n");
		}

		this.terminal.showCursor();
		this.terminal.stop();
		this.onStop?.();
	}

	requestRender(force = false): void {
		if (force) {
			this.previousLines = [];
			this.previousWidth = -1; // -1 triggers widthChanged, forcing a full clear
			this.previousHeight = -1; // -1 triggers heightChanged, forcing a full clear
			this.cursorRow = 0;
			this.hardwareCursorRow = 0;
			this.maxLinesRendered = 0;
			this.previousViewportTop = 0;
			if (this.renderTimer) {
				clearTimeout(this.renderTimer);
				this.renderTimer = undefined;
			}
			this.renderRequested = true;
			process.nextTick(() => {
				if (this.stopped || !this.renderRequested) {
					renderLog(`force-render skipped stopped=${this.stopped} requested=${this.renderRequested}`);
					return;
				}
				this.renderRequested = false;
				this.lastRenderAt = performance.now();
				try {
					this.doRender();
					this.renderErrorCount = 0;
					renderLog("force-render complete");
				} catch (err) {
					this.handleRenderError(err);
				}
			});
			return;
		}
		if (this.renderRequested) return;
		this.renderRequested = true;
		process.nextTick(() => this.scheduleRender());
	}

	private scheduleRender(): void {
		if (this.stopped || this.renderTimer || !this.renderRequested) {
			return;
		}
		const elapsed = performance.now() - this.lastRenderAt;
		const delay = Math.max(0, TUI.MIN_RENDER_INTERVAL_MS - elapsed);
		// lint-ignore: RAWTIMER render scheduling
		this.renderTimer = setTimeout(() => {
			this.renderTimer = undefined;
			if (this.stopped || !this.renderRequested) {
				return;
			}
			this.renderRequested = false;
			this.lastRenderAt = performance.now();
			try {
				this.doRender();
				this.renderErrorCount = 0;
			} catch (err) {
				this.handleRenderError(err);
			}
			// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- doRender() may set renderRequested=true via requestRender() callback
			if (this.renderRequested) {
				this.scheduleRender();
			}
		}, delay);
	}

	private handleRenderError(err: unknown): void {
		this.renderErrorCount++;
		const msg = err instanceof Error ? err.message : String(err);
		renderLog(`RENDER ERROR (${this.renderErrorCount}/${TUI.MAX_RENDER_ERRORS}) ${msg}`);
		traceEvent("tui:render:error", { error: msg, count: this.renderErrorCount });
		if (this.renderErrorCount >= TUI.MAX_RENDER_ERRORS) {
			traceEvent("tui:render:halted", { after: this.renderErrorCount });
			this.stopped = true;
		}
	}

	private handleInput(data: string): void {
		if (this.onRawInput?.(data)) return;
		if (this.inputListeners.size > 0) {
			let current = data;
			for (const listener of this.inputListeners) {
				const result = listener(current);
				if (result?.consume) {
					return;
				}
				if (result?.data !== undefined) {
					current = result.data;
				}
			}
			if (current.length === 0) {
				return;
			}
			data = current;
		}

		// Consume terminal cell size responses without blocking unrelated input.
		if (this.consumeCellSizeResponse(data)) {
			return;
		}

		// Global debug key handler (Shift+Ctrl+D)
		if (matchesKey(data, "shift+ctrl+d") && this.onDebug) {
			this.onDebug();
			return;
		}

		// If focused component is an overlay, verify it's still visible
		// (visibility can change due to terminal resize or visible() callback)
		const focusedOverlay = this.overlayStack.find((o) => o.component === this.focusedComponent);
		if (focusedOverlay && !this.isOverlayVisible(focusedOverlay)) {
			// Focused overlay is no longer visible, redirect to topmost visible overlay
			const topVisible = this.getTopmostVisibleOverlay();
			if (topVisible) {
				this.setFocus(topVisible.component);
			} else {
				// No visible overlays, restore to preFocus
				this.setFocus(focusedOverlay.preFocus);
			}
		}

		// Pass input to focused component (including Ctrl+C)
		// The focused component can decide how to handle Ctrl+C
		if (this.focusedComponent?.handleInput) {
			// Filter out key release events unless component opts in
			if (isKeyRelease(data) && !this.focusedComponent.wantsKeyRelease) {
				return;
			}
			this.focusedComponent.handleInput(data);
			this.requestRender();
		}
	}

	private consumeCellSizeResponse(data: string): boolean {
		// Response format: ESC [ 6 ; height ; width t
		const match = data.match(/^\x1b\[6;(\d+);(\d+)t$/);
		if (!match) {
			return false;
		}

		const heightPx = parseInt(match[1]!, 10);
		const widthPx = parseInt(match[2]!, 10);
		if (heightPx <= 0 || widthPx <= 0) {
			return true;
		}

		setCellDimensions({ widthPx, heightPx });
		// Invalidate all components so images re-render with correct dimensions.
		this.invalidate();
		this.requestRender();
		return true;
	}

	/**
	 * Resolve overlay layout from options.
	 * Returns { width, row, col, maxHeight } for rendering.
	 */
	private resolveOverlayLayout(
		options: OverlayOptions | undefined,
		overlayHeight: number,
		termWidth: number,
		termHeight: number,
	): { width: number; row: number; col: number; maxHeight: number | undefined } {
		const opt = options ?? {};

		// Parse margin (clamp to non-negative)
		const margin =
			typeof opt.margin === "number"
				? { top: opt.margin, right: opt.margin, bottom: opt.margin, left: opt.margin }
				: (opt.margin ?? {});
		const marginTop = Math.max(0, margin.top ?? 0);
		const marginRight = Math.max(0, margin.right ?? 0);
		const marginBottom = Math.max(0, margin.bottom ?? 0);
		const marginLeft = Math.max(0, margin.left ?? 0);

		// Available space after margins
		const availWidth = Math.max(1, termWidth - marginLeft - marginRight);
		const availHeight = Math.max(1, termHeight - marginTop - marginBottom);

		// === Resolve width ===
		let width = parseSizeValue(opt.width, termWidth) ?? Math.min(80, availWidth);
		// Apply minWidth
		if (opt.minWidth !== undefined) {
			width = Math.max(width, opt.minWidth);
		}
		// Clamp to available space
		width = Math.max(1, Math.min(width, availWidth));

		// === Resolve maxHeight ===
		let maxHeight = parseSizeValue(opt.maxHeight, termHeight);
		// Clamp to available space
		if (maxHeight !== undefined) {
			maxHeight = Math.max(1, Math.min(maxHeight, availHeight));
		}

		// Effective overlay height (may be clamped by maxHeight)
		const effectiveHeight = maxHeight !== undefined ? Math.min(overlayHeight, maxHeight) : overlayHeight;

		// === Resolve position ===
		let row: number;
		let col: number;

		if (opt.row !== undefined) {
			if (typeof opt.row === "string") {
				// Percentage: 0% = top, 100% = bottom (overlay stays within bounds)
				const match = opt.row.match(/^(\d+(?:\.\d+)?)%$/);
				if (match) {
					const maxRow = Math.max(0, availHeight - effectiveHeight);
					const percent = parseFloat(match[1]!) / 100;
					row = marginTop + Math.floor(maxRow * percent);
				} else {
					// Invalid format, fall back to center
					row = this.resolveAnchorRow("center", effectiveHeight, availHeight, marginTop);
				}
			} else {
				// Absolute row position
				row = opt.row;
			}
		} else {
			// Anchor-based (default: center)
			const anchor = opt.anchor ?? "center";
			row = this.resolveAnchorRow(anchor, effectiveHeight, availHeight, marginTop);
		}

		if (opt.col !== undefined) {
			if (typeof opt.col === "string") {
				// Percentage: 0% = left, 100% = right (overlay stays within bounds)
				const match = opt.col.match(/^(\d+(?:\.\d+)?)%$/);
				if (match) {
					const maxCol = Math.max(0, availWidth - width);
					const percent = parseFloat(match[1]!) / 100;
					col = marginLeft + Math.floor(maxCol * percent);
				} else {
					// Invalid format, fall back to center
					col = this.resolveAnchorCol("center", width, availWidth, marginLeft);
				}
			} else {
				// Absolute column position
				col = opt.col;
			}
		} else {
			// Anchor-based (default: center)
			const anchor = opt.anchor ?? "center";
			col = this.resolveAnchorCol(anchor, width, availWidth, marginLeft);
		}

		// Apply offsets
		if (opt.offsetY !== undefined) row += opt.offsetY;
		if (opt.offsetX !== undefined) col += opt.offsetX;

		// Clamp to terminal bounds (respecting margins)
		row = Math.max(marginTop, Math.min(row, termHeight - marginBottom - effectiveHeight));
		col = Math.max(marginLeft, Math.min(col, termWidth - marginRight - width));

		return { width, row, col, maxHeight };
	}

	private resolveAnchorRow(anchor: OverlayAnchor, height: number, availHeight: number, marginTop: number): number {
		switch (anchor) {
			case "top-left":
			case "top-center":
			case "top-right":
				return marginTop;
			case "bottom-left":
			case "bottom-center":
			case "bottom-right":
				return marginTop + availHeight - height;
			case "left-center":
			case "center":
			case "right-center":
				return marginTop + Math.floor((availHeight - height) / 2);
		}
	}

	private resolveAnchorCol(anchor: OverlayAnchor, width: number, availWidth: number, marginLeft: number): number {
		switch (anchor) {
			case "top-left":
			case "left-center":
			case "bottom-left":
				return marginLeft;
			case "top-right":
			case "right-center":
			case "bottom-right":
				return marginLeft + availWidth - width;
			case "top-center":
			case "center":
			case "bottom-center":
				return marginLeft + Math.floor((availWidth - width) / 2);
		}
	}

	/** Composite all overlays into content lines (sorted by focusOrder, higher = on top). */
	private compositeOverlays(lines: string[], termWidth: number, termHeight: number): string[] {
		if (this.overlayStack.length === 0) return lines;
		const result = [...lines];

		// Pre-render all visible overlays and calculate positions
		const rendered: { overlayLines: string[]; row: number; col: number; w: number }[] = [];
		let minLinesNeeded = result.length;

		const visibleEntries = this.overlayStack.filter((e) => this.isOverlayVisible(e));
		visibleEntries.sort((a, b) => a.focusOrder - b.focusOrder);
		for (const entry of visibleEntries) {
			const { component, options } = entry;

			// Get layout with height=0 first to determine width and maxHeight
			// (width and maxHeight don't depend on overlay height)
			const { width, maxHeight } = this.resolveOverlayLayout(options, 0, termWidth, termHeight);

			// Render component at calculated width
			let overlayLines = component.render(width);

			// Apply maxHeight if specified
			if (maxHeight !== undefined && overlayLines.length > maxHeight) {
				overlayLines = overlayLines.slice(0, maxHeight);
			}

			// Get final row/col with actual overlay height
			const { row, col } = this.resolveOverlayLayout(options, overlayLines.length, termWidth, termHeight);

			rendered.push({ overlayLines, row, col, w: width });
			minLinesNeeded = Math.max(minLinesNeeded, row + overlayLines.length);
		}

		// Pad to at least terminal height so overlays have screen-relative positions.
		// Excludes maxLinesRendered: the historical high-water mark caused self-reinforcing
		// inflation that pushed content into scrollback on terminal widen.
		const workingHeight = Math.max(result.length, termHeight, minLinesNeeded);

		// Extend result with empty lines if content is too short for overlay placement or working area
		while (result.length < workingHeight) {
			result.push("");
		}

		const viewportStart = Math.max(0, workingHeight - termHeight);

		// Composite each overlay
		for (const { overlayLines, row, col, w } of rendered) {
			for (let i = 0; i < overlayLines.length; i++) {
				const idx = viewportStart + row + i;
				if (idx >= 0 && idx < result.length) {
					// Defensive: truncate overlay line to declared width before compositing
					// (components should already respect width, but this ensures it)
					const truncatedOverlayLine =
						visibleWidth(overlayLines[i]!) > w ? sliceByColumn(overlayLines[i]!, 0, w, true) : overlayLines[i]!;
					result[idx] = this.compositeLineAt(result[idx]!, truncatedOverlayLine, col, w, termWidth);
				}
			}
		}

		return result;
	}

	private static readonly SEGMENT_RESET = "\x1b[0m\x1b]8;;\x07";

	private applyLineResets(lines: string[]): string[] {
		const reset = TUI.SEGMENT_RESET;
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i]!;
			if (!isImageLine(line)) {
				lines[i] = normalizeTerminalOutput(line) + reset;
			}
		}
		return lines;
	}

	private collectKittyImageIds(lines: string[]): Set<number> {
		const ids = new Set<number>();
		for (const line of lines) {
			for (const id of extractKittyImageIds(line)) {
				ids.add(id);
			}
		}
		return ids;
	}

	private deleteKittyImages(ids: Iterable<number>): string {
		let buffer = "";
		for (const id of ids) {
			buffer += deleteKittyImage(id);
		}
		return buffer;
	}

	private expandLastChangedForKittyImages(firstChanged: number, lastChanged: number): number {
		let expandedLastChanged = lastChanged;
		for (let i = firstChanged; i < this.previousLines.length; i++) {
			if (extractKittyImageIds(this.previousLines[i]!).length > 0) {
				expandedLastChanged = Math.max(expandedLastChanged, i);
			}
		}
		return expandedLastChanged;
	}

	private deleteChangedKittyImages(firstChanged: number, lastChanged: number): string {
		if (firstChanged < 0 || lastChanged < firstChanged) return "";

		const ids = new Set<number>();
		const maxLine = Math.min(lastChanged, this.previousLines.length - 1);
		for (let i = firstChanged; i <= maxLine; i++) {
			for (const id of extractKittyImageIds(this.previousLines[i] ?? "")) {
				ids.add(id);
			}
		}

		return this.deleteKittyImages(ids);
	}

	/** Splice overlay content into a base line at a specific column. Single-pass optimized. */
	private compositeLineAt(
		baseLine: string,
		overlayLine: string,
		startCol: number,
		overlayWidth: number,
		totalWidth: number,
	): string {
		if (isImageLine(baseLine)) return baseLine;

		// Single pass through baseLine extracts both before and after segments
		const afterStart = startCol + overlayWidth;
		const base = extractSegments(baseLine, startCol, afterStart, totalWidth - afterStart, true);

		// Extract overlay with width tracking (strict=true to exclude wide chars at boundary)
		const overlay = sliceWithWidth(overlayLine, 0, overlayWidth, true);

		// Pad segments to target widths
		const beforePad = Math.max(0, startCol - base.beforeWidth);
		const overlayPad = Math.max(0, overlayWidth - overlay.width);
		const actualBeforeWidth = Math.max(startCol, base.beforeWidth);
		const actualOverlayWidth = Math.max(overlayWidth, overlay.width);
		const afterTarget = Math.max(0, totalWidth - actualBeforeWidth - actualOverlayWidth);
		const afterPad = Math.max(0, afterTarget - base.afterWidth);

		// Compose result
		const r = TUI.SEGMENT_RESET;
		const result =
			base.before +
			" ".repeat(beforePad) +
			r +
			overlay.text +
			" ".repeat(overlayPad) +
			r +
			base.after +
			" ".repeat(afterPad);

		// CRITICAL: Always verify and truncate to terminal width.
		// This is the final safeguard against width overflow which would crash the TUI.
		// Width tracking can drift from actual visible width due to:
		// - Complex ANSI/OSC sequences (hyperlinks, colors)
		// - Wide characters at segment boundaries
		// - Edge cases in segment extraction
		const resultWidth = visibleWidth(result);
		if (resultWidth <= totalWidth) {
			return result;
		}
		// Truncate with strict=true to ensure we don't exceed totalWidth
		return sliceByColumn(result, 0, totalWidth, true);
	}

	/**
	 * Find and extract cursor position from rendered lines.
	 * Searches for CURSOR_MARKER, calculates its position, and strips it from the output.
	 * Only scans the bottom terminal height lines (visible viewport).
	 * @param lines - Rendered lines to search
	 * @param height - Terminal height (visible viewport size)
	 * @returns Cursor position { row, col } or null if no marker found
	 */
	private extractCursorPosition(lines: string[], height: number): { row: number; col: number } | null {
		// Only scan the bottom `height` lines (visible viewport)
		const viewportTop = Math.max(0, lines.length - height);
		for (let row = lines.length - 1; row >= viewportTop; row--) {
			const line = lines[row]!;
			const markerIndex = line.indexOf(CURSOR_MARKER);
			if (markerIndex !== -1) {
				// Calculate visual column (width of text before marker)
				const beforeMarker = line.slice(0, markerIndex);
				const col = visibleWidth(beforeMarker);

				// Strip marker from the line
				lines[row] = line.slice(0, markerIndex) + line.slice(markerIndex + CURSOR_MARKER.length);

				return { row, col };
			}
		}
		return null;
	}

	private partitionChildren(width: number): { scrollRegion: string[]; dock: string[] } {
		const split = this.dockFromChild ? this.children.indexOf(this.dockFromChild) : -1;
		const dockAt = split >= 0 ? split : this.children.length;
		const scrollable: string[] = [];
		const dock: string[] = [];
		for (let i = 0; i < this.children.length; i++) {
			const childLines = this.children[i]!.render(width);
			if (i < dockAt) scrollable.push(...childLines);
			else dock.push(...childLines);
		}
		return { scrollRegion: scrollable, dock };
	}

	/** Keep the bottom of the dock band (editor/footer); drop overflow from the top. */
	private capDockLines(lines: string[], height: number): string[] {
		const maxDock = Math.max(1, height - 1);
		if (lines.length <= maxDock) return lines;
		return lines.slice(lines.length - maxDock);
	}

	private alignBody(scrollable: string[], bodyRows: number): string[] {
		if (bodyRows <= 0) return [];
		if (scrollable.length >= bodyRows) return scrollable.slice(-bodyRows);
		return [...Array.from({ length: bodyRows - scrollable.length }, () => ""), ...scrollable];
	}

	/**
	 * Push archived chat lines into terminal scrollback via a body-only scroll region,
	 * so the dock band (rows below bodyRows) never enters scrollback.
	 */
	private scrollArchivedIntoHistory(archived: string[], bodyRows: number): void {
		if (archived.length === 0 || bodyRows <= 0) return;
		let buffer = `\x1b[1;${bodyRows}r`;
		buffer += `\x1b[${bodyRows};1H`;
		for (const line of archived) {
			buffer += `\r\n\x1b[2K${line}`;
		}
		buffer += "\x1b[r";
		this.terminal.write(buffer);
	}

	/**
	 * Dock-band render path: viewport is always a fixed-height frame
	 * (chat body + dock). Live widgets never shift into scrollback.
	 */
	private doRenderDocked(width: number, height: number, widthChanged: boolean, heightChanged: boolean): void {
		const { scrollRegion, dock: dockRaw } = this.partitionChildren(width);
		const dock = this.capDockLines(dockRaw, height);
		const bodyRows = height - dock.length;
		let frame = [...this.alignBody(scrollRegion, bodyRows), ...dock];

		if (this.overlayStack.length > 0) {
			frame = this.compositeOverlays(frame, width, height);
			if (frame.length > height) frame = frame.slice(-height);
			while (frame.length < height) frame.push("");
		}

		const cursorPos = this.extractCursorPosition(frame, height);
		frame = this.applyLineResets(frame);

		const prevScroll = this.previousScrollable;
		const prevBodyRows = this.previousDockBodyRows;
		const dockHeightChanged = prevBodyRows > 0 && prevBodyRows !== bodyRows;
		if (!widthChanged && !heightChanged && !dockHeightChanged && prevBodyRows > 0 && prevScroll.length > 0) {
			const oldStart = Math.max(0, prevScroll.length - prevBodyRows);
			const newStart = Math.max(0, scrollRegion.length - bodyRows);
			if (newStart > oldStart) {
				this.scrollArchivedIntoHistory(scrollRegion.slice(oldStart, newStart), bodyRows);
			}
		}
		this.previousScrollable = scrollRegion;
		this.previousDockBodyRows = bodyRows;

		const useDec2026 = this.terminal.dec2026Active;

		const paintFrame = (clear: boolean): void => {
			this.fullRedrawCount += 1;
			let buffer = useDec2026 ? "\x1b[?2026h" : "";
			buffer += "\x1b[?25l";
			if (clear) {
				buffer += this.deleteKittyImages(this.previousKittyImageIds);
				// Clear the viewport only — never ESC[3J (erase saved lines). That
				// truncates pre-Alef shell history and chat archived into scrollback.
				buffer += "\x1b[2J\x1b[H";
			} else {
				buffer += "\x1b[H";
			}
			for (let i = 0; i < frame.length; i++) {
				if (i > 0) buffer += "\r\n";
				buffer += "\x1b[2K";
				const line = frame[i]!;
				buffer += visibleWidth(line) > width ? truncateToWidth(line, width, "…") : line;
			}
			buffer += "\x1b[?25h";
			if (useDec2026) buffer += "\x1b[?2026l";
			this.terminal.write(buffer);
			this.cursorRow = Math.max(0, frame.length - 1);
			this.hardwareCursorRow = this.cursorRow;
			this.maxLinesRendered = height;
			this.previousViewportTop = 0;
			this.positionHardwareCursor(cursorPos, frame.length);
			this.previousLines = frame;
			this.previousKittyImageIds = this.collectKittyImageIds(frame);
			this.previousWidth = width;
			this.previousHeight = height;
			this.onRender?.(frame.join("\n"), width, height);
		};

		if (this.previousLines.length === 0 || widthChanged || heightChanged) {
			this.renderMeta = {
				renderPath: this.previousLines.length === 0 ? "first" : widthChanged ? "width-change" : "height-change",
				firstChanged: 0,
				prevViewportTop: 0,
				totalLines: frame.length,
				height,
				ts: Date.now(),
			};
			paintFrame(this.previousLines.length > 0);
			return;
		}

		// Dock band grew/shrank (autocomplete, editor wrap, widgets) without a
		// terminal resize. Differential paint can leave a ghost footer/editor line
		// in the vacated rows — rewrite the full viewport but do NOT \x1b[3J
		// (that would wipe scrollback just archived above).
		if (dockHeightChanged) {
			this.renderMeta = {
				renderPath: "dock-reflow",
				firstChanged: 0,
				prevViewportTop: 0,
				totalLines: frame.length,
				height,
				ts: Date.now(),
			};
			paintFrame(false);
			return;
		}

		// Differential render for dock mode. Uses absolute cursor positioning
		// (\x1b[row;1H) per changed line to avoid the cursor drift that caused
		// the earlier full-render fallback.
		let firstChanged = -1;
		let lastChanged = -1;
		for (let i = 0; i < frame.length; i++) {
			if ((this.previousLines[i] ?? "") !== frame[i]) {
				if (firstChanged === -1) firstChanged = i;
				lastChanged = i;
			}
		}

		if (firstChanged === -1) {
			this.renderMeta = {
				renderPath: "no-change",
				firstChanged: -1,
				prevViewportTop: 0,
				totalLines: frame.length,
				height,
				ts: Date.now(),
			};
			this.positionHardwareCursor(cursorPos, frame.length);
			this.previousLines = frame;
			this.previousHeight = height;
			this.onRender?.(frame.join("\n"), width, height);
			return;
		}

		this.renderMeta = {
			renderPath: "diff",
			firstChanged,
			prevViewportTop: 0,
			totalLines: frame.length,
			height,
			ts: Date.now(),
		};

		let buffer = useDec2026 ? "\x1b[?2026h" : "";
		buffer += "\x1b[?25l";
		buffer += this.deleteChangedKittyImages(firstChanged, lastChanged);
		for (let i = firstChanged; i <= lastChanged; i++) {
			if ((this.previousLines[i] ?? "") === frame[i]) continue;
			buffer += `\x1b[${i + 1};1H\x1b[2K`;
			const line = frame[i]!;
			buffer += visibleWidth(line) > width ? truncateToWidth(line, width, "\u2026") : line;
		}
		buffer += "\x1b[?25h";
		if (useDec2026) buffer += "\x1b[?2026l";
		this.terminal.write(buffer);
		this.cursorRow = Math.max(0, frame.length - 1);
		this.hardwareCursorRow = lastChanged;
		this.maxLinesRendered = height;
		this.previousViewportTop = 0;
		this.positionHardwareCursor(cursorPos, frame.length);
		this.previousLines = frame;
		this.previousKittyImageIds = this.collectKittyImageIds(frame);
		this.previousWidth = width;
		this.previousHeight = height;
		this.onRender?.(frame.join("\n"), width, height);
	}

	private doRender(): void {
		if (this.stopped) return;
		const width = this.terminal.columns;
		const height = this.terminal.rows;
		const widthChanged = this.previousWidth !== 0 && this.previousWidth !== width;
		const heightChanged = this.previousHeight !== 0 && this.previousHeight !== height;

		if (this.dockFromChild && this.children.includes(this.dockFromChild)) {
			this.doRenderDocked(width, height, widthChanged, heightChanged);
			return;
		}

		const previousBufferLength = this.previousHeight > 0 ? this.previousViewportTop + this.previousHeight : height;
		let prevViewportTop = heightChanged ? Math.max(0, previousBufferLength - height) : this.previousViewportTop;
		let viewportTop = prevViewportTop;
		let hardwareCursorRow = this.hardwareCursorRow;
		const computeLineDiff = (targetRow: number): number => {
			const currentScreenRow = hardwareCursorRow - prevViewportTop;
			const targetScreenRow = targetRow - viewportTop;
			return targetScreenRow - currentScreenRow;
		};

		let newLines = this.render(width);

		// Composite overlays into the rendered lines (before differential compare)
		if (this.overlayStack.length > 0) {
			newLines = this.compositeOverlays(newLines, width, height);
		}

		// Extract cursor position before applying line resets (marker must be found first)
		const cursorPos = this.extractCursorPosition(newLines, height);

		newLines = this.applyLineResets(newLines);

		// Helper to clear scrollback and viewport and render all new lines
		const useDec2026 = this.terminal.dec2026Active;

		const fullRender = (clear: boolean): void => {
			this.fullRedrawCount += 1;
			let buffer = useDec2026 ? "\x1b[?2026h" : ""; // Begin synchronized output (if supported)
			buffer += "\x1b[?25l"; // T-1: hide cursor — fallback for terminals without DEC 2026
			if (clear) {
				buffer += this.deleteKittyImages(this.previousKittyImageIds);
				// Viewport clear only — ESC[3J would wipe terminal scrollback.
				buffer += "\x1b[2J\x1b[H";
			}
			for (let i = 0; i < newLines.length; i++) {
				if (i > 0) buffer += "\r\n";
				const line = newLines[i]!;
				buffer += visibleWidth(line) > width ? truncateToWidth(line, width, "\u2026") : line;
			}
			buffer += "\x1b[?25h"; // T-1: show cursor
			if (useDec2026) buffer += "\x1b[?2026l"; // End synchronized output
			this.terminal.write(buffer);
			this.cursorRow = Math.max(0, newLines.length - 1);
			this.hardwareCursorRow = this.cursorRow;
			// Reset max lines when clearing, otherwise track growth
			if (clear) {
				this.maxLinesRendered = newLines.length;
			} else {
				this.maxLinesRendered = Math.max(this.maxLinesRendered, newLines.length);
			}
			const bufferLength = Math.max(height, newLines.length);
			this.previousViewportTop = Math.max(0, bufferLength - height);
			this.positionHardwareCursor(cursorPos, newLines.length);
			this.previousLines = newLines;
			this.previousKittyImageIds = this.collectKittyImageIds(newLines);
			this.previousWidth = width;
			this.previousHeight = height;
			this.onRender?.(newLines.join("\n"), width, height);
		};

		// Tag the render decision into this.renderMeta so onRender callers can inspect it.
		// firstChanged and prevViewportTop may not be computed yet for early-exit branches;
		// those sites pass their own values explicitly via the override params.
		const tagRender = (path: RenderMeta["renderPath"], fcOverride = -1, vptOverride = prevViewportTop): void => {
			this.renderMeta = {
				renderPath: path,
				firstChanged: fcOverride,
				prevViewportTop: vptOverride,
				totalLines: newLines.length,
				height,
				ts: Date.now(),
			};
		};

		const debugRedraw = process.env.ALEF_DEBUG_REDRAW === "1";
		const logRedraw = (reason: string): void => {
			if (!debugRedraw) return;
			const msg = `[${new Date().toISOString()}] fullRender: ${reason} (prev=${this.previousLines.length}, new=${newLines.length}, height=${height})\n`;
			try {
				fs.writeFileSync(2, msg);
			} catch {}
		};

		// First render - just output everything without clearing (assumes clean screen)
		if (this.previousLines.length === 0 && !widthChanged && !heightChanged) {
			logRedraw("first render");
			tagRender("first");
			fullRender(false);
			return;
		}

		// Width changes always need a full re-render because wrapping changes.
		if (widthChanged) {
			logRedraw(`terminal width changed (${this.previousWidth} -> ${width})`);
			tagRender("width-change");
			fullRender(true);
			return;
		}

		// Height changes normally need a full re-render to keep the visible viewport aligned,
		// but Termux changes height when the software keyboard shows or hides.
		// In that environment, a full redraw causes the entire history to replay on every toggle.
		if (heightChanged && !isTermuxSession()) {
			logRedraw(`terminal height changed (${this.previousHeight} -> ${height})`);
			tagRender("height-change");
			fullRender(true);
			return;
		}

		// Content shrunk below the working area and no overlays - re-render to clear empty rows
		// (overlays need the padding, so only do this when no overlays are active)
		// Configurable via setClearOnShrink() or ALEF_CLEAR_ON_SHRINK=0 env var
		if (this.clearOnShrink && newLines.length < this.maxLinesRendered && this.overlayStack.length === 0) {
			logRedraw(`clearOnShrink (maxLinesRendered=${this.maxLinesRendered})`);
			tagRender("clear-shrink");
			fullRender(true);
			return;
		}

		// Find first and last changed lines
		let firstChanged = -1;
		let lastChanged = -1;
		const maxLines = Math.max(newLines.length, this.previousLines.length);
		for (let i = 0; i < maxLines; i++) {
			const oldLine = i < this.previousLines.length ? this.previousLines[i] : "";
			const newLine = i < newLines.length ? newLines[i] : "";

			if (oldLine !== newLine) {
				if (firstChanged === -1) {
					firstChanged = i;
				}
				lastChanged = i;
			}
		}
		const appendedLines = newLines.length > this.previousLines.length;
		if (appendedLines) {
			if (firstChanged === -1) {
				firstChanged = this.previousLines.length;
			}
			lastChanged = newLines.length - 1;
		}
		if (firstChanged !== -1) {
			lastChanged = this.expandLastChangedForKittyImages(firstChanged, lastChanged);
		}
		const appendStart = appendedLines && firstChanged === this.previousLines.length && firstChanged > 0;

		// No changes - but still need to update hardware cursor position if it moved
		if (firstChanged === -1) {
			tagRender("no-change", firstChanged);
			this.positionHardwareCursor(cursorPos, newLines.length);
			this.previousViewportTop = prevViewportTop;
			this.previousHeight = height;
			return;
		}

		// All changes are in deleted lines (nothing to render, just clear)
		if (firstChanged >= newLines.length) {
			if (this.previousLines.length > newLines.length) {
				let buffer = "\x1b[?2026h";
				buffer += this.deleteChangedKittyImages(firstChanged, lastChanged);
				// Move to end of new content (clamp to 0 for empty content)
				const targetRow = Math.max(0, newLines.length - 1);
				if (targetRow < prevViewportTop) {
					logRedraw(`deleted lines moved viewport up (${targetRow} < ${prevViewportTop})`);
					tagRender("deleted", firstChanged);
					fullRender(true);
					return;
				}
				const lineDiff = computeLineDiff(targetRow);
				if (lineDiff > 0) buffer += `\x1b[${lineDiff}B`;
				else if (lineDiff < 0) buffer += `\x1b[${-lineDiff}A`;
				buffer += "\r";
				// Clear extra lines without scrolling
				const extraLines = this.previousLines.length - newLines.length;
				if (extraLines > height) {
					logRedraw(`extraLines > height (${extraLines} > ${height})`);
					tagRender("deleted", firstChanged);
					fullRender(true);
					return;
				}
				if (extraLines > 0) {
					buffer += "\x1b[1B";
				}
				for (let i = 0; i < extraLines; i++) {
					buffer += "\r\x1b[2K";
					if (i < extraLines - 1) buffer += "\x1b[1B";
				}
				if (extraLines > 0) {
					buffer += `\x1b[${extraLines}A`;
				}
				buffer += "\x1b[?2026l";
				this.terminal.write(buffer);
				this.cursorRow = targetRow;
				this.hardwareCursorRow = targetRow;
			}
			this.positionHardwareCursor(cursorPos, newLines.length);
			this.previousLines = newLines;
			this.previousKittyImageIds = this.collectKittyImageIds(newLines);
			this.previousWidth = width;
			this.previousHeight = height;
			this.previousViewportTop = prevViewportTop;
			return;
		}

		// Differential rendering can only touch what was in the visible viewport.
		// Lines above prevViewportTop are in scrollback — the terminal cannot update them.
		// T-3: instead of fullRender (which emits \x1b[2J causing a blank-frame flash),
		// accept the above-viewport change as lost and render only the visible portion.
		if (firstChanged < prevViewportTop) {
			tagRender("scrollback", firstChanged);
			// Find if anything in the visible viewport also changed.
			let viewFirstChanged = -1;
			let viewLastChanged = -1;
			const vMax = Math.max(newLines.length, this.previousLines.length);
			for (let i = prevViewportTop; i < vMax; i++) {
				const o = i < this.previousLines.length ? this.previousLines[i] : "";
				const n = i < newLines.length ? newLines[i] : "";
				if (o !== n) {
					if (viewFirstChanged === -1) viewFirstChanged = i;
					viewLastChanged = i;
				}
			}
			if (viewFirstChanged === -1) {
				// Nothing visible changed — commit new state, no write.
				this.positionHardwareCursor(cursorPos, newLines.length);
				this.previousLines = newLines;
				this.previousKittyImageIds = this.collectKittyImageIds(newLines);
				this.previousWidth = width;
				this.previousHeight = height;
				this.previousViewportTop = prevViewportTop;
				this.onRender?.(newLines.join("\n"), width, height);
				return;
			}
			// Viewport has changes too — override firstChanged to start from viewport,
			// then fall through to the differential render path.
			firstChanged = viewFirstChanged;
			lastChanged = viewLastChanged;
		}

		// Render from first changed line to end
		// Build buffer with all updates wrapped in synchronized output
		tagRender(appendStart ? "append" : "diff", firstChanged);
		let buffer = useDec2026 ? "\x1b[?2026h" : ""; // Begin synchronized output (if supported)
		buffer += "\x1b[?25l"; // T-1: hide cursor before any cursor movement
		buffer += this.deleteChangedKittyImages(firstChanged, lastChanged);
		const prevViewportBottom = prevViewportTop + height - 1;
		const moveTargetRow = appendStart ? firstChanged - 1 : firstChanged;
		if (moveTargetRow > prevViewportBottom) {
			const currentScreenRow = Math.max(0, Math.min(height - 1, hardwareCursorRow - prevViewportTop));
			const moveToBottom = height - 1 - currentScreenRow;
			if (moveToBottom > 0) {
				buffer += `\x1b[${moveToBottom}B`;
			}
			const scroll = moveTargetRow - prevViewportBottom;
			buffer += "\r\n".repeat(scroll);
			prevViewportTop += scroll;
			viewportTop += scroll;
			hardwareCursorRow = moveTargetRow;
		}

		// Move cursor to first changed line (use hardwareCursorRow for actual position)
		const lineDiff = computeLineDiff(moveTargetRow);
		if (lineDiff > 0) {
			buffer += `\x1b[${lineDiff}B`; // Move down
		} else if (lineDiff < 0) {
			buffer += `\x1b[${-lineDiff}A`; // Move up
		}

		buffer += appendStart ? "\r\n" : "\r"; // Move to column 0

		// Only render changed lines (firstChanged to lastChanged), not all lines to end
		// This reduces flicker when only a single line changes (e.g., spinner animation)
		const renderEnd = Math.min(lastChanged, newLines.length - 1);
		for (let i = firstChanged; i <= renderEnd; i++) {
			if (i > firstChanged) buffer += "\r\n";
			buffer += "\x1b[2K"; // Clear current line
			const line = newLines[i]!;
			const isImage = isImageLine(line);
			if (!isImage && visibleWidth(line) > width) {
				renderLog(`Line ${i} exceeds width (${visibleWidth(line)} > ${width}), truncating`);
				newLines[i] = truncateToWidth(line, width, "\u2026");
			}
			buffer += newLines[i];
		}

		// Track where cursor ended up after rendering
		let finalCursorRow = renderEnd;

		// If we had more lines before, clear them and move cursor back
		if (this.previousLines.length > newLines.length) {
			// Move to end of new content first if we stopped before it
			if (renderEnd < newLines.length - 1) {
				const moveDown = newLines.length - 1 - renderEnd;
				buffer += `\x1b[${moveDown}B`;
				finalCursorRow = newLines.length - 1;
			}
			const extraLines = this.previousLines.length - newLines.length;
			for (let i = newLines.length; i < this.previousLines.length; i++) {
				buffer += "\r\n\x1b[2K";
			}
			// Move cursor back to end of new content
			buffer += `\x1b[${extraLines}A`;
		}

		buffer += "\x1b[?25h"; // T-1: show cursor after all movement
		if (useDec2026) buffer += "\x1b[?2026l"; // End synchronized output

		if (process.env.ALEF_TUI_DEBUG === "1") {
			const debugDir = "/tmp/tui";
			fs.mkdirSync(debugDir, { recursive: true });
			const debugPath = path.join(debugDir, `render-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
			const debugData = [
				`firstChanged: ${firstChanged}`,
				`viewportTop: ${viewportTop}`,
				`cursorRow: ${this.cursorRow}`,
				`height: ${height}`,
				`lineDiff: ${lineDiff}`,
				`hardwareCursorRow: ${hardwareCursorRow}`,
				`renderEnd: ${renderEnd}`,
				`finalCursorRow: ${finalCursorRow}`,
				`cursorPos: ${JSON.stringify(cursorPos)}`,
				`newLines.length: ${newLines.length}`,
				`previousLines.length: ${this.previousLines.length}`,
				"",
				"=== newLines ===",
				JSON.stringify(newLines, null, 2),
				"",
				"=== previousLines ===",
				JSON.stringify(this.previousLines, null, 2),
				"",
				"=== buffer ===",
				JSON.stringify(buffer),
			].join("\n");
			fs.writeFileSync(debugPath, debugData);
		}

		// Write entire buffer at once
		this.terminal.write(buffer);

		// Track cursor position for next render
		// cursorRow tracks end of content (for viewport calculation)
		// hardwareCursorRow tracks actual terminal cursor position (for movement)
		this.cursorRow = Math.max(0, newLines.length - 1);
		this.hardwareCursorRow = finalCursorRow;
		// Track terminal's working area (grows but doesn't shrink unless cleared)
		this.maxLinesRendered = Math.max(this.maxLinesRendered, newLines.length);
		this.previousViewportTop = Math.max(prevViewportTop, finalCursorRow - height + 1);

		// Position hardware cursor for IME
		this.positionHardwareCursor(cursorPos, newLines.length);

		this.previousLines = newLines;
		this.previousKittyImageIds = this.collectKittyImageIds(newLines);
		this.previousWidth = width;
		this.previousHeight = height;
		this.onRender?.(newLines.join("\n"), width, height);
	}

	/**
	 * Position the hardware cursor for IME candidate window.
	 * @param cursorPos The cursor position extracted from rendered output, or null
	 * @param totalLines Total number of rendered lines
	 */
	private positionHardwareCursor(cursorPos: { row: number; col: number } | null, totalLines: number): void {
		if (!cursorPos || totalLines <= 0) {
			this.terminal.hideCursor();
			return;
		}

		// Clamp cursor position to valid range
		const targetRow = Math.max(0, Math.min(cursorPos.row, totalLines - 1));
		const targetCol = Math.max(0, cursorPos.col);

		// Move cursor from current position to target
		const rowDelta = targetRow - this.hardwareCursorRow;
		let buffer = "";
		if (rowDelta > 0) {
			buffer += `\x1b[${rowDelta}B`; // Move down
		} else if (rowDelta < 0) {
			buffer += `\x1b[${-rowDelta}A`; // Move up
		}
		// Move to absolute column (1-indexed)
		buffer += `\x1b[${targetCol + 1}G`;

		if (buffer) {
			this.terminal.write(buffer);
		}

		this.hardwareCursorRow = targetRow;
		if (this.showHardwareCursor) {
			this.terminal.showCursor();
		} else {
			this.terminal.hideCursor();
		}
	}
}
