import type { Component } from "@dpopsuev/alef-tui";
import { Container, Editor, type EditorTheme, type SelectListTheme, Text, type TUI } from "@dpopsuev/alef-tui";

class ArcEditorWrapper implements Component {
	constructor(
		private readonly inner: Editor,
		private readonly arcColor: (s: string) => string,
	) {}

	render(width: number): string[] {
		const lines = this.inner.render(width);
		const arc = (_l: string, open: boolean): string => {
			const fill = Math.max(0, width - 2);
			return this.arcColor(open ? `╭${"─".repeat(fill)}╮` : `╰${"─".repeat(fill)}╯`);
		};
		if (lines.length >= 2) {
			lines[0] = arc(lines[0], true);
			lines[lines.length - 1] = arc(lines[lines.length - 1], false);
		}
		return lines;
	}

	invalidate(): void {
		this.inner.invalidate();
	}
}

import { EventPressure, pressureToInterval, timeBasedHue } from "./event-pressure.js";
import { buildPool, randomCodePoint } from "./splash.js";
import { bold, type ColorToken, color, colorDepth, dim, fgCode, glyph, type ThemeTokens } from "./theme.js";
import { DynamicText } from "./tui/dynamic-text.js";
import { pillFooterStr } from "./tui/pill.js";
import { toolActiveLine } from "./tui/tool-view.js";

/**
 * ConsoleZone — the fixed interactive surface at the bottom of the TUI.
 *
 * Owns: zone delimiter, spinner/status slot, editor, hint bar, model label.
 * Mounted once via mount(); structure never changes after that.
 */
function shiftedAccentAnsi(token: ColorToken, hueDegrees: number): string {
	if (colorDepth() !== "truecolor" || !token.truecolor) return fgCode(token, colorDepth());
	const hex = token.truecolor.replace("#", "");
	const r0 = parseInt(hex.slice(0, 2), 16) / 255;
	const g0 = parseInt(hex.slice(2, 4), 16) / 255;
	const b0 = parseInt(hex.slice(4, 6), 16) / 255;
	const vv = Math.max(r0, g0, b0);
	const d = vv - Math.min(r0, g0, b0);
	const ss = vv === 0 ? 0 : d / vv;
	let hh = 0;
	if (d > 0) {
		if (vv === r0) hh = ((g0 - b0) / d + (g0 < b0 ? 6 : 0)) / 6;
		else if (vv === g0) hh = ((b0 - r0) / d + 2) / 6;
		else hh = ((r0 - g0) / d + 4) / 6;
	}
	const nh = (hh + hueDegrees / 360) % 1;
	const i = Math.floor(nh * 6);
	const f = nh * 6 - i;
	const p = vv * (1 - ss);
	const q = vv * (1 - f * ss);
	const t2 = vv * (1 - (1 - f) * ss);
	const sectors: Array<[number, number, number]> = [
		[vv, t2, p],
		[q, vv, p],
		[p, vv, t2],
		[p, q, vv],
		[t2, p, vv],
		[vv, p, q],
	];
	const [fr, fg2, fb] = sectors[i % 6] ?? [vv, vv, vv];
	return `\x1b[38;2;${Math.round(fr * 255)};${Math.round(fg2 * 255)};${Math.round(fb * 255)}m`;
}

export class ConsoleZone {
	readonly editor: Editor;

	private readonly statusText: Text;
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
	private readonly inFlightCalls = new Map<string, { dt: DynamicText; startedAt: number }>();

	constructor(tui: TUI, t: ThemeTokens, modelId: string) {
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
			description: (s) => dim(s),
			scrollInfo: (s) => dim(s),
			noMatch: (s) => dim(s),
		};
		const editorTheme: EditorTheme = {
			borderColor: (s) => color(s, t.dimFg),
			selectList: selectListTheme,
		};
		this.editor = new Editor(tui, editorTheme);

		this.pendingFooter = new DynamicText((w) => {
			if (!this.pendingFooterActive) return "";
			const line = pillFooterStr(w);
			const colored = color(line, this.pendingFooterFg);
			return this.pendingFooterBgFn ? this.pendingFooterBgFn(colored) : colored;
		});

		void modelId; // stored via addChild below
		this._modelId = modelId;
	}

	private readonly _modelId: string;

	mount(): void {
		this.tui.addChild(this.pendingFooter);
		this.tui.addChild(this.inFlightQueue);
		this.tui.addChild(this.statusText);
		this.tui.addChild(new ArcEditorWrapper(this.editor, (s) => color(s, this.t.dimFg)));
		this.tui.addChild(new DynamicText((_w) => dim("/exit · /new · /resume · /help")));
		this.tui.addChild(new Text(dim(this._modelId), 0, 0));
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
			const elapsedS = Math.floor(elapsedMs / 1000);
			const frame = this.frames[this.frameIdx] ?? glyph("state:active");
			const level = this.pressure.level();
			// Hue cycles through the full 360° spectrum over time;
			// pressure multiplies the rotation rate so busy turns spin faster.
			const hue = timeBasedHue(elapsedMs, level);
			const ansi = shiftedAccentAnsi(this.t.accentFg, hue) || fgCode(this.t.warnFg, colorDepth());
			this.statusText.setText(`  ${ansi}${frame}\x1b[0m ${color(`${elapsedS}s`, this.t.dimFg)}`);
			this.tui.requestRender();
			this.thinkingTimer = setTimeout(tick, pressureToInterval(level));
		};
		this.thinkingTimer = setTimeout(tick, pressureToInterval(0));
	}

	stopThinking(): void {
		clearTimeout(this.thinkingTimer);
		this.thinkingTimer = undefined;
		this.statusText.setText("");
	}

	setStatus(text: string): void {
		this.statusText.setText(text);
	}

	get isThinking(): boolean {
		return this.thinkingTimer !== undefined;
	}

	/** Add a live-updating in-flight call row to the fixed console zone. */
	showInFlightCall(callId: string, name: string, keyArg: string): void {
		const startedAt = Date.now();
		const t = this.t;
		const dt = new DynamicText((_w) => toolActiveLine(name, keyArg, t, Date.now() - startedAt));
		this.inFlightCalls.set(callId, { dt, startedAt });
		this.inFlightQueue.addChild(dt);
		this.tui.requestRender();
	}

	/** Remove an in-flight call row once the call completes. */
	removeInFlightCall(callId: string): void {
		const entry = this.inFlightCalls.get(callId);
		if (entry) {
			this.inFlightQueue.removeChild(entry.dt);
			this.inFlightCalls.delete(callId);
			this.tui.requestRender();
		}
	}

	showPendingFooter(fg: ColorToken, bgFn: ((s: string) => string) | null = null): void {
		this.pendingFooterFg = fg;
		this.pendingFooterBgFn = bgFn;
		this.pendingFooterActive = true;
		this.tui.requestRender();
	}

	/** Remove the pending footer — call once the real footer lands in scrollback. */
	hidePendingFooter(): void {
		this.pendingFooterActive = false;
		this.tui.requestRender();
	}
}
