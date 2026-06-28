import type { Component } from "@dpopsuev/alef-tui";
import {
	AgentCard,
	type AgentCardTheme,
	CancellableLoader,
	Container,
	Editor,
	type EditorTheme,
	type FlowElement,
	FlowLayout,
	numericInterpolator,
	type SelectListTheme,
	SeparatorLine,
	SlotMachine,
	Text,
	Toast,
	type TUI,
} from "@dpopsuev/alef-tui";
export type { Component };

import { CommandHintGrid } from "./command-hint-grid.js";
import { registry } from "./commands.js";

class EditorWrapper implements Component {
	private readonly topBorder = new SeparatorLine();
	private readonly bottomBorder = new SeparatorLine();

	constructor(private readonly inner: Editor) {}

	setModeLabel(label: string): void {
		this.bottomBorder.setLabel(label);
	}

	render(width: number): string[] {
		const lines = this.inner.render(width);
		if (lines.length < 2) return lines;
		lines[0] = this.topBorder.render(width)[0];
		lines[lines.length - 1] = this.bottomBorder.render(width)[0];
		return lines;
	}

	invalidate(): void {
		this.inner.invalidate();
	}
}

import { accentColorize, DynamicText, fmtMs, spinnerFrame } from "@dpopsuev/alef-tui/views";

const SPINNER_FRAME_COUNT = 12;
const CHUNK_ACCUMULATOR_MAX_CHARS = 500;
const CHUNK_TAIL_MAX_CHARS = 120;
const MAX_WIDGET_HEIGHT_FRACTION = 0.2;
const MIN_WIDGET_LINES = 3;

import { EventPressure, pressureToInterval } from "@dpopsuev/alef-agent/event-pressure";
import { lookupColor } from "@dpopsuev/alef-agent/identity/palette";
import { bold, type ColorToken, color, glyph, statusGlyph, type ThemeTokens } from "./runner-theme.js";
import { buildPool, randomCodePoint } from "./splash.js";

export class PromptConsole {
	readonly editor: Editor;

	private readonly statusText: Text;
	private editorWrapper!: EditorWrapper;
	private readonly frames: string[];
	private frameIdx = 0;
	private thinkingStart = 0;
	private thinkingTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly pressure = new EventPressure();
	private readonly tui: TUI;
	private readonly t: ThemeTokens;

	private readonly pendingFooter: DynamicText;
	private pendingFooterStyle: (s: string) => string = (s) => s;
	private pendingFooterActive = false;

	private readonly inFlightQueue = new Container();
	private readonly inFlightCalls = new Map<
		string,
		{
			card: AgentCard;
			startedAt: number;
			lastChunk: string;
			identity: { color: string; address: string; token: ColorToken; modelId?: string } | null;
			inputSlot: SlotMachine<number>;
			outputSlot: SlotMachine<number>;
			children: Map<string, { name: string; keyArg: string; startedAt: number; depth: number }>;
		}
	>();
	private cardTheme: AgentCardTheme | undefined;
	private readonly chunkDetail: Text;
	private readonly inspectorHint: Text;
	private focusedId: string | null = null;
	private hintBar!: Text;
	private commandGrid!: CommandHintGrid;
	private intentText = "";
	private readonly backgroundTaskPanel = new Text("", 0, 0);
	private readonly backgroundTasks = new Map<
		string,
		{ taskId: string; profile: string; status: string; startedAt: number }
	>();
	readonly widgetSlotAbove = new Container();
	readonly widgetSlotBelow = new Container();
	private widgetAboveText: Text | null = null;

	constructor(tui: TUI, t: ThemeTokens, _modelId: string) {
		this.tui = tui;
		this.t = t;

		const spinnerPool = buildPool();
		const spinnerBlock = spinnerPool[0];
		this.frames = Array.from({ length: SPINNER_FRAME_COUNT }, () => randomCodePoint(spinnerBlock));

		this.statusText = new Text("", 0, 0);

		const selectListTheme: SelectListTheme = {
			selectedPrefix: (s) => bold(s),
			selectedText: (s) => bold(s),
			description: (s) => color(s, t.mutedFg),
			scrollInfo: (s) => color(s, t.mutedFg),
			noMatch: (s) => color(s, t.mutedFg),
		};
		const editorTheme: EditorTheme = {
			borderColor: (s) => color(s, t.mutedFg),
			selectList: selectListTheme,
		};
		this.editor = new Editor(tui, editorTheme);

		this.chunkDetail = new Text("", 2, 0);
		this.inspectorHint = new Text("", 0, 0);

		this.pendingFooter = new DynamicText((w) => {
			if (!this.pendingFooterActive) return "";
			return new SeparatorLine({ style: this.pendingFooterStyle }).render(w)[0];
		});
	}

	mount(): void {
		this.tui.addChild(this.pendingFooter);
		this.tui.addChild(this.inFlightQueue);
		this.tui.addChild(this.chunkDetail);
		this.tui.addChild(this.inspectorHint);
		this.tui.addChild(this.backgroundTaskPanel);
		this.tui.addChild(this.statusText);
		this.tui.addChild(this.widgetSlotAbove);
		this.editorWrapper = new EditorWrapper(this.editor);
		this.tui.addChild(this.editorWrapper);

		this.editor.onChange = (text) => {
			this.updateCommandHints(text);
			this.tui.requestRender();
		};

		this.commandGrid = new CommandHintGrid({
			commands: registry.list().map((c) => ({ name: c.name, description: c.description })),
			style: (s) => color(s, this.t.mutedFg),
		});
		this.tui.addChild(this.commandGrid);
		this.tui.addChild(this.widgetSlotBelow);

		this.hintBar = new Text("", 0, 0);
		this.tui.addChild(this.hintBar);
	}

	pulse(): void {
		this.pressure.pulse();
	}

	startThinking(): void {
		if (this.thinkingTimer) {
			clearTimeout(this.thinkingTimer);
			this.thinkingTimer = undefined;
		}
		this.thinkingStart = Date.now();
		this.frameIdx = 0;
		const tick = (): void => {
			this.frameIdx = (this.frameIdx + 1) % this.frames.length;
			const elapsedMs = Date.now() - this.thinkingStart;
			const elapsedS = fmtMs(elapsedMs);
			const frame = this.frames[this.frameIdx] ?? glyph("state:active");
			const level = this.pressure.level();
			// Hue cycles through the full 360° spectrum over time;
			// pressure multiplies the rotation rate so busy turns spin faster.
			const colorize = accentColorize(this.t.accentFg, elapsedMs);
			const intent = this.intentText ? `  ${color(this.intentText, this.t.mutedFg)}` : "";
			this.statusText.setText(`  ${colorize(frame)} ${colorize(elapsedS)}${intent}`);
			this.refreshCards();
			this.tui.requestRender();
			this.thinkingTimer = setTimeout(tick, pressureToInterval(level));
		};
		this.thinkingTimer = setTimeout(tick, pressureToInterval(0));
		this.commandGrid.hide();
		this.hintBar.setText(this.inFlightCalls.size > 0 ? color("Tab to inspect subagents", this.t.mutedFg) : "");
	}

	stopThinking(): void {
		clearTimeout(this.thinkingTimer);
		this.thinkingTimer = undefined;
		this.statusText.setText("");
		this.hintBar.setText("");
		this.intentText = "";
	}

	updateCommandHints(editorText: string): void {
		if (editorText.startsWith(":")) {
			const query = editorText.slice(1).trim();
			this.commandGrid.setFilter(query);
			this.commandGrid.show();
		} else {
			this.commandGrid.hide();
		}
	}

	setStatus(text: string): void {
		this.editorWrapper.setModeLabel(text);
	}

	setHint(text: string): void {
		this.hintBar.setText(text);
	}

	setIntent(text: string): void {
		this.intentText = text;
	}

	setWidgetAbove(text: string): void {
		if (!text) {
			if (this.widgetAboveText) {
				this.widgetSlotAbove.removeChild(this.widgetAboveText);
				this.widgetAboveText = null;
			}
			return;
		}
		const maxLines = Math.max(MIN_WIDGET_LINES, Math.floor(this.tui.terminal.rows * MAX_WIDGET_HEIGHT_FRACTION));
		const lines = text.split("\n");
		const truncated =
			lines.length > maxLines ? [...lines.slice(0, maxLines), `  … ${lines.length - maxLines} more`] : lines;
		const activeGlyph = statusGlyph("active");
		const doneGlyph = statusGlyph("done");
		const currentGlyph = glyph("state:current");
		const colored = truncated.map((line) => {
			if (line.includes(activeGlyph) || line.includes(currentGlyph)) return color(line, this.t.accentFg);
			if (line.includes(doneGlyph)) return color(line, this.t.mutedFg);
			return line;
		});
		const display = colored.join("\n");
		if (!this.widgetAboveText) {
			this.widgetAboveText = new Text(display, 0, 0);
			this.widgetSlotAbove.addChild(this.widgetAboveText);
		} else {
			this.widgetAboveText.setText(display);
		}
	}

	get isThinking(): boolean {
		return this.thinkingTimer !== undefined;
	}

	private getCardTheme(): AgentCardTheme {
		if (!this.cardTheme) {
			const t = this.t;
			this.cardTheme = {
				primary: (s) => color(s, t.primaryFg),
				secondary: (s) => color(s, t.secondaryFg),
				muted: (s) => color(s, t.mutedFg),
				accent: (s) => color(s, t.accentFg),
				identity: (s) => color(s, t.accentFg),
			};
		}
		return this.cardTheme;
	}

	showInFlightCall(callId: string, name: string, keyArg: string): void {
		const startedAt = Date.now();
		const card = new AgentCard(this.getCardTheme(), {
			name,
			keyArg,
			elapsedMs: 0,
			inputTokens: 0,
			outputTokens: 0,
			lastChunk: "",
			spinner: spinnerFrame(callId, 0),
			children: [],
		});
		const fmtCompact = (n: number) => {
			if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
			if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
			return String(n);
		};
		const slotOpts = {
			format: fmtCompact,
			interpolate: numericInterpolator,
			style: (s: string) => color(s, this.t.secondaryFg),
			dimStyle: (s: string) => color(s, this.t.mutedFg),
		};
		const entry = {
			card,
			startedAt,
			lastChunk: "",
			identity: null as { color: string; address: string; token: ColorToken; modelId?: string } | null,
			inputSlot: new SlotMachine(this.tui, 0, { ...slotOpts, prefix: "↑" }),
			outputSlot: new SlotMachine(this.tui, 0, { ...slotOpts, prefix: "↓" }),
			children: new Map<string, { name: string; keyArg: string; startedAt: number; depth: number }>(),
		};
		this.inFlightCalls.set(callId, entry);
		this.inFlightQueue.addChild(card);
		if (this.inFlightCalls.size === 1 && this.isThinking) {
			this.hintBar.setText(color("Tab to inspect subagents", this.t.mutedFg));
		}
		this.tui.requestRender();
	}

	private readonly chunkAccumulators = new Map<string, string>();

	updateInFlightCallChunk(callId: string, text: string): void {
		const entry = this.inFlightCalls.get(callId);
		if (entry) {
			const accumulated = (this.chunkAccumulators.get(callId) ?? "") + text;
			this.chunkAccumulators.set(callId, accumulated.slice(-CHUNK_ACCUMULATOR_MAX_CHARS));
			const lines = accumulated.split("\n").filter((l) => l.trim());
			entry.lastChunk = (lines.at(-1) ?? "").slice(-CHUNK_TAIL_MAX_CHARS);
		}
	}

	removeInFlightCall(callId: string): void {
		const entry = this.inFlightCalls.get(callId);
		if (entry) {
			entry.inputSlot.dispose();
			entry.outputSlot.dispose();
			this.inFlightQueue.removeChild(entry.card);
			this.inFlightCalls.delete(callId);
			this.chunkAccumulators.delete(callId);
			this.refreshCards();
			this.tui.requestRender();
		}
	}

	showPendingFooter(fg: ColorToken): void {
		this.pendingFooterActive = true;
		this.pendingFooterStyle = (s) => color(s, fg);
		this.tui.requestRender();
	}

	hidePendingFooter(): void {
		this.pendingFooterActive = false;
		this.tui.requestRender();
	}

	setFocusedCall(callId: string | null): void {
		this.focusedId = callId;
		if (callId) {
			this.inspectorHint.setText(color("  j/k scroll  Esc close  Ctrl+X cancel", this.t.mutedFg));
		} else {
			this.chunkDetail.setText("");
			this.inspectorHint.setText("");
		}
		this.refreshCards();
		this.tui.requestRender();
	}

	setChunkText(text: string): void {
		this.chunkDetail.setText(text);
		this.tui.requestRender();
	}

	setCallIdentity(callId: string, colorName: string, address: string, modelId?: string): void {
		const entry = this.inFlightCalls.get(callId);
		if (!entry) return;
		const paletteColor = lookupColor(colorName);
		const token = paletteColor ? { truecolor: paletteColor.hex } : this.t.accentFg;
		entry.identity = { color: colorName, address, token, modelId };
		entry.card.update({ address, modelId });
		this.tui.requestRender();
	}

	updateCallTokens(callId: string, input: number, output: number): void {
		const entry = this.inFlightCalls.get(callId);
		if (!entry) return;
		entry.inputSlot.set(input);
		entry.outputSlot.set(output);
	}

	addChildCall(parentCallId: string, callId: string, name: string, keyArg: string, depth: number): void {
		const entry = this.inFlightCalls.get(parentCallId);
		if (!entry) return;
		entry.children.set(callId, { name, keyArg, startedAt: Date.now(), depth });
		this.tui.requestRender();
	}

	removeChildCall(parentCallId: string, callId: string): void {
		const entry = this.inFlightCalls.get(parentCallId);
		if (!entry) return;
		entry.children.delete(callId);
		this.tui.requestRender();
	}

	showToast(message: string, durationMs = 3000): void {
		const toast = new Toast({
			message,
			durationMs,
			theme: {
				text: (s) => color(s, this.t.secondaryFg),
				dim: (s) => color(s, this.t.mutedFg),
			},
			onExpire: () => {
				this.widgetSlotBelow.removeChild(toast);
				this.tui.requestRender();
			},
		});
		this.widgetSlotBelow.addChild(toast);
		this.tui.requestRender();
	}

	showBackgroundTask(taskId: string, profile: string): void {
		this.backgroundTasks.set(taskId, { taskId, profile, status: "running", startedAt: Date.now() });
		this.refreshBackgroundTaskPanel();
	}

	updateBackgroundTask(taskId: string, status: "completed" | "failed", _detail?: string): void {
		const task = this.backgroundTasks.get(taskId);
		if (task) task.status = status;
		this.refreshBackgroundTaskPanel();
		setTimeout(() => {
			this.backgroundTasks.delete(taskId);
			this.refreshBackgroundTaskPanel();
		}, 10_000);
	}

	private refreshBackgroundTaskPanel(): void {
		if (this.backgroundTasks.size === 0) {
			this.backgroundTaskPanel.setText("");
			this.tui.requestRender();
			return;
		}
		const lines: string[] = [];
		for (const task of this.backgroundTasks.values()) {
			const elapsed = fmtMs(Date.now() - task.startedAt);
			const icon =
				task.status === "running"
					? statusGlyph("active")
					: task.status === "completed"
						? statusGlyph("done")
						: statusGlyph("error");
			const style = task.status === "running" ? this.t.accentFg : this.t.mutedFg;
			lines.push(color(`  ${icon} ${task.taskId}  ${task.profile}  ${elapsed}`, style));
		}
		this.backgroundTaskPanel.setText(lines.join("\n"));
		this.tui.requestRender();
	}

	buildFlowLayout(): FlowLayout | null {
		if (this.inFlightCalls.size < 2) return null;
		const elements: FlowElement[] = [];
		let idx = 0;
		for (const [callId, entry] of this.inFlightCalls) {
			if (idx > 0) elements.push({ type: "edge" });
			const status = this.focusedId === callId ? "active" : "pending";
			elements.push({
				type: "node",
				node: {
					id: callId,
					title: entry.card.focused ? `▸ ${callId.slice(0, 8)}` : callId.slice(0, 8),
					status,
					content: entry.card,
				},
			});
			idx++;
		}
		return new FlowLayout({ elements });
	}

	showCancellableLoader(message: string, onAbort: () => void): CancellableLoader {
		const loader = new CancellableLoader(
			this.tui,
			(s) => color(s, this.t.accentFg),
			(s) => color(s, this.t.mutedFg),
			message,
		);
		loader.onAbort = () => {
			this.widgetSlotBelow.removeChild(loader);
			onAbort();
			this.tui.requestRender();
		};
		loader.start();
		this.widgetSlotBelow.addChild(loader);
		this.tui.requestRender();
		return loader;
	}

	removeCancellableLoader(loader: CancellableLoader): void {
		loader.dispose();
		this.widgetSlotBelow.removeChild(loader);
		this.tui.requestRender();
	}

	private refreshCards(): void {
		const hasFocus = this.focusedId !== null;
		for (const [callId, entry] of this.inFlightCalls) {
			const focused = callId === this.focusedId;
			const elapsed = Date.now() - entry.startedAt;
			entry.card.focused = focused;
			entry.card.dimmed = hasFocus && !focused;
			entry.card.update({
				elapsedMs: elapsed,
				spinner: spinnerFrame(callId, elapsed),
				lastChunk: entry.lastChunk,
				inputTokens: entry.inputSlot.get(),
				outputTokens: entry.outputSlot.get(),
				tokenDisplay:
					entry.inputSlot.get() > 0
						? `${entry.inputSlot.currentStyled()} ${entry.outputSlot.currentStyled()}`
						: undefined,
				children: [...entry.children.entries()].map(([id, c]) => ({
					id,
					name: c.name,
					keyArg: c.keyArg,
					elapsedMs: Date.now() - c.startedAt,
					depth: c.depth,
					spinner: spinnerFrame(id, Date.now() - c.startedAt),
				})),
			});
		}
	}
}
