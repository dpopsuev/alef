import type { Component } from "@dpopsuev/alef-tui";
import { Container, Editor, type EditorTheme, type SelectListTheme, Text, type TUI } from "@dpopsuev/alef-tui";
import { registry } from "./commands/index.js";
import { CommandHintGrid } from "./tui/command-hint-grid.js";

class EditorWrapper implements Component {
	constructor(
		private readonly inner: Editor,
		private readonly ruleColor: (s: string) => string,
	) {}

	render(width: number): string[] {
		const lines = this.inner.render(width);
		if (lines.length < 2) return lines;
		lines[0] = this.ruleColor("─".repeat(width));
		return lines;
	}

	invalidate(): void {
		this.inner.invalidate();
	}
}

class ModeDelimiter implements Component {
	private label = "";

	constructor(private readonly ruleColor: (s: string) => string) {}

	setLabel(label: string): void {
		this.label = label;
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (this.label) {
			const text = ` ${this.label} `;
			return [this.ruleColor(`─${text}${"─".repeat(Math.max(0, width - text.length - 1))}`)];
		}
		return [this.ruleColor("─".repeat(width))];
	}
}

import { EventPressure, pressureToInterval } from "./event-pressure.js";
import { hexToColorToken, lookupColor } from "./identity/palette.js";
import { buildPool, randomCodePoint } from "./splash.js";
import { bold, type ColorToken, color, glyph, type ThemeTokens } from "./theme.js";
import { fmtMs } from "./tui/ansi-utils.js";
import { DynamicText } from "./tui/dynamic-text.js";
import { accentColorize, spinnerFrame } from "./tui/spinner.js";
import { toolActiveLine } from "./tui/tool-view.js";

export class PromptConsole {
	readonly editor: Editor;

	private readonly statusText: Text;
	private modeDelimiter!: ModeDelimiter;
	private readonly frames: string[];
	private frameIdx = 0;
	private thinkingStart = 0;
	private thinkingTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly pressure = new EventPressure();
	private readonly tui: TUI;
	private readonly t: ThemeTokens;

	private readonly pendingFooter: DynamicText;
	private pendingFooterFg: ColorToken = { ansi16: 96 };
	private pendingFooterBgFn: ((s: string) => string) | null = null;
	private pendingFooterActive = false;

	private readonly inFlightQueue = new Container();
	private readonly inFlightCalls = new Map<
		string,
		{
			dt: DynamicText;
			startedAt: number;
			lastChunk: string;
			identity: { color: string; address: string; token: ColorToken } | null;
			children: Map<string, { name: string; keyArg: string; startedAt: number; depth: number }>;
		}
	>();
	private readonly chunkDetail: Text;
	private readonly inspectorHint: Text;
	private focusedId: string | null = null;
	private hintBar!: Text;
	private commandGrid!: CommandHintGrid;

	constructor(tui: TUI, t: ThemeTokens, _modelId: string) {
		this.tui = tui;
		this.t = t;

		const spinnerPool = buildPool();
		const spinnerBlock = spinnerPool[0];
		this.frames = Array.from({ length: 12 }, () =>
			spinnerBlock ? randomCodePoint(spinnerBlock) : glyph("state:active"),
		);

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
			const line = "─".repeat(Math.max(0, w));
			const colored = color(line, this.pendingFooterFg);
			return this.pendingFooterBgFn ? this.pendingFooterBgFn(colored) : colored;
		});
	}

	mount(): void {
		this.tui.addChild(this.pendingFooter);
		this.tui.addChild(this.inFlightQueue);
		this.tui.addChild(this.chunkDetail);
		this.tui.addChild(this.inspectorHint);
		this.tui.addChild(this.statusText);
		this.tui.addChild(new EditorWrapper(this.editor, (s) => color(s, this.t.mutedFg)));
		this.modeDelimiter = new ModeDelimiter((s) => color(s, this.t.mutedFg));
		this.tui.addChild(this.modeDelimiter);

		this.editor.onChange = (text) => {
			this.updateCommandHints(text);
			this.tui.requestRender();
		};

		this.commandGrid = new CommandHintGrid({
			commands: registry.list().map((c) => ({ name: c.name, description: c.description })),
			style: (s) => color(s, this.t.mutedFg),
		});
		this.tui.addChild(this.commandGrid);

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
			this.statusText.setText(`  ${colorize(frame)} ${colorize(elapsedS)}`);
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
		this.modeDelimiter.setLabel(text);
	}

	setHint(text: string): void {
		this.hintBar.setText(text);
	}

	get isThinking(): boolean {
		return this.thinkingTimer !== undefined;
	}

	showInFlightCall(callId: string, name: string, keyArg: string): void {
		const startedAt = Date.now();
		const t = this.t;
		const entry = {
			dt: null as unknown as DynamicText,
			startedAt,
			lastChunk: "",
			identity: null as { color: string; address: string; token: ColorToken } | null,
			children: new Map<string, { name: string; keyArg: string; startedAt: number; depth: number }>(),
		};
		const dt = new DynamicText((w) => {
			const elapsed = Date.now() - startedAt;
			const displayName = entry.identity ? `${name}  ${color(entry.identity.address, entry.identity.token)}` : name;
			const statusLine = toolActiveLine(displayName, keyArg, t, elapsed, callId);
			const focused = this.focusedId === callId;
			const marker = focused ? `${color(">", t.accentFg)}${statusLine.slice(1)}` : statusLine;
			const chunkColor = entry.identity?.token ?? t.secondaryFg;
			const maxChunkLen = Math.max(20, w - 8);
			const chunkLine = entry.lastChunk ? `     ${color(entry.lastChunk.slice(-maxChunkLen), chunkColor)}` : "";
			const lines = [chunkLine ? `${marker}\n${chunkLine}` : marker];
			for (const [childId, child] of entry.children) {
				const indent = "  ".repeat(child.depth + 1);
				const childElapsed = Date.now() - child.startedAt;
				lines.push(
					`${indent}${spinnerFrame(childId, childElapsed)} ${color(child.name, t.secondaryFg)}  ${color(child.keyArg, t.mutedFg)}`,
				);
			}
			return lines.join("\n");
		});
		entry.dt = dt;
		this.inFlightCalls.set(callId, entry);
		this.inFlightQueue.addChild(dt);
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
			this.chunkAccumulators.set(callId, accumulated.slice(-500));
			const lastLine =
				accumulated
					.split("\n")
					.filter((l) => l.trim())
					.at(-1) ?? "";
			entry.lastChunk = lastLine.slice(-120);
		}
	}

	removeInFlightCall(callId: string): void {
		const entry = this.inFlightCalls.get(callId);
		if (entry) {
			this.inFlightQueue.removeChild(entry.dt);
			this.inFlightCalls.delete(callId);
			this.chunkAccumulators.delete(callId);
			this.tui.requestRender();
		}
	}

	showPendingFooter(fg: ColorToken): void {
		this.pendingFooterFg = fg;
		this.pendingFooterBgFn = null;
		this.pendingFooterActive = true;
		this.tui.requestRender();
	}

	/** Remove the pending footer — call once the real footer lands in scrollback. */
	hidePendingFooter(): void {
		this.pendingFooterActive = false;
		this.tui.requestRender();
	}

	setFocusedCall(callId: string | null): void {
		this.focusedId = callId;
		if (!callId) {
			this.chunkDetail.setText("");
			this.inspectorHint.setText("");
			this.tui.requestRender();
			return;
		}
		const total = this.inFlightCalls.size;
		const idx = [...this.inFlightCalls.keys()].indexOf(callId) + 1;
		this.inspectorHint.setText(
			color(`  ${idx}/${total}  Tab cycle · j/k scroll · Ctrl+X cancel · Esc close`, this.t.mutedFg),
		);
		this.tui.requestRender();
	}

	setChunkText(text: string): void {
		this.chunkDetail.setText(text ? color(text, this.t.secondaryFg) : "");
		this.tui.requestRender();
	}

	setCallIdentity(callId: string, colorName: string, address: string): void {
		const entry = this.inFlightCalls.get(callId);
		if (!entry) return;
		const paletteColor = lookupColor(colorName);
		const token = paletteColor ? hexToColorToken(paletteColor.hex) : this.t.accentFg;
		(entry as unknown as { identity: unknown }).identity = { color: colorName, address, token };
		this.tui.requestRender();
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
}
