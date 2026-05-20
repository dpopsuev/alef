import { Editor, type EditorTheme, type SelectListTheme, Text, type TUI } from "@dpopsuev/alef-tui";
import { DynamicText } from "./dynamic-text.js";
import { buildPool, randomCodePoint } from "./splash.js";
import { bold, color, dim, glyph, type ThemeTokens } from "./theme.js";

/**
 * ConsoleZone — the fixed interactive surface at the bottom of the TUI.
 *
 * Owns: zone delimiter, spinner/status slot, editor, hint bar, model label.
 * Mounted once via mount(); structure never changes after that.
 */
export class ConsoleZone {
	readonly editor: Editor;

	private readonly statusText: Text;
	private readonly frames: string[];
	private frameIdx = 0;
	private thinkingStart = 0;
	private thinkingTimer: ReturnType<typeof setInterval> | undefined;
	private readonly tui: TUI;
	private readonly t: ThemeTokens;

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

		void modelId; // stored via addChild below
		this._modelId = modelId;
	}

	private readonly _modelId: string;

	mount(): void {
		this.tui.addChild(this.statusText);
		this.tui.addChild(this.editor);
		this.tui.addChild(new DynamicText((_w) => dim("/exit · /new · /resume · /help")));
		this.tui.addChild(new Text(dim(this._modelId), 0, 0));
	}

	startThinking(): void {
		if (this.thinkingTimer) {
			clearInterval(this.thinkingTimer);
			this.thinkingTimer = undefined;
		}
		this.thinkingStart = Date.now();
		this.frameIdx = 0;
		this.thinkingTimer = setInterval(() => {
			this.frameIdx = (this.frameIdx + 1) % this.frames.length;
			const elapsed = Math.floor((Date.now() - this.thinkingStart) / 1000);
			const frame = this.frames[this.frameIdx] ?? glyph("state:active");
			this.statusText.setText(`  ${color(frame, this.t.warnFg)} ${color(`${elapsed}s`, this.t.dimFg)}`);
			this.tui.requestRender();
		}, 180);
	}

	stopThinking(): void {
		clearInterval(this.thinkingTimer);
		this.thinkingTimer = undefined;
		this.statusText.setText("");
	}

	setStatus(text: string): void {
		this.statusText.setText(text);
	}

	get isThinking(): boolean {
		return this.thinkingTimer !== undefined;
	}
}
