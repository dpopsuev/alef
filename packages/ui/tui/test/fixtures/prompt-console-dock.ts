/**
 * PromptConsole-shaped dock band for scrollback purity tests.
 *
 * Mirrors packages/cli/src/client/console.ts mount() child order:
 *   pendingFooter (dock anchor) → inFlight → chunkDetail → inspectorHint →
 *   backgroundTasks → status → widgetAbove → pendingQueue → editorWrapper →
 *   widgetBelow → hintBar → footer (layout adds DashboardFooter last)
 */

import type { Component } from "../../src/component.js";
import { Editor } from "../../src/components/editor.js";
import { SeparatorLine } from "../../src/components/separator-line.js";
import { Text } from "../../src/components/text.js";
import { Container, type TUI } from "../../src/tui.js";
import { DynamicText } from "../../src/views/index.js";
import { defaultEditorTheme } from "../test-themes.js";

/** Editor + upper/lower SeparatorLine — same role as private EditorWrapper. */
class EditorChrome implements Component {
	readonly topBorder = new SeparatorLine({ labelAlign: "right" });
	readonly bottomBorder = new SeparatorLine();

	constructor(readonly editor: Editor) {}

	setModeLabel(label: string): void {
		this.bottomBorder.setLeftLabel(label);
	}

	setTopicLabel(label: string): void {
		this.topBorder.setRightLabel(label);
	}

	render(width: number): string[] {
		const lines = this.editor.render(width);
		if (lines.length < 2) return lines;
		lines[0] = this.topBorder.render(width)[0]!;
		const bottomIndex = lines.length - 1 - this.editor.autocompleteLineCount();
		if (bottomIndex >= 1) {
			lines[bottomIndex] = this.bottomBorder.render(width)[0]!;
		}
		return lines;
	}

	invalidate(): void {
		this.editor.invalidate();
	}
}

export interface PromptConsoleDockFixture {
	chat: Container;
	inFlight: Container;
	status: Text;
	widgetAbove: Container;
	editor: Editor;
	chrome: EditorChrome;
	footer: DynamicText;
	setMode(label: string): void;
	setTopic(label: string): void;
	/** Replace in-flight agent cards (dock height churn). */
	setInFlightLines(lines: string[]): void;
	setThinkingLine(text: string): void;
}

/**
 * Mount scrollable chat + PromptConsole-ordered dock band on `tui`.
 * Caller owns TUI lifecycle (start/stop) and terminal.
 */
export function mountPromptConsoleDock(tui: TUI): PromptConsoleDockFixture {
	const chat = new Container();
	tui.addChild(chat);

	const pendingFooter = new DynamicText(() => "");
	tui.addChild(pendingFooter);
	tui.setDock(pendingFooter);

	const inFlight = new Container();
	tui.addChild(inFlight);
	tui.addChild(new Text("", 0, 0)); // chunkDetail
	tui.addChild(new Text("", 0, 0)); // inspectorHint
	tui.addChild(new Text("", 0, 0)); // backgroundTaskPanel

	const status = new Text("", 0, 0);
	tui.addChild(status);

	const widgetAbove = new Container();
	tui.addChild(widgetAbove);
	tui.addChild(new Text("", 0, 0)); // pendingQueue

	const editor = new Editor(tui, defaultEditorTheme);
	const chrome = new EditorChrome(editor);
	tui.addChild(chrome);
	tui.addChild(new Container()); // widgetBelow
	tui.addChild(new Text("", 0, 0)); // hintBar

	let footerText = "STICKY_FOOTER ctx 19k";
	const footer = new DynamicText(() => footerText);
	tui.addChild(footer);

	chrome.setModeLabel("INSERT");
	chrome.setTopicLabel("STICKY_TOPIC Explore the code base");
	editor.setText("STICKY_EDITOR prompt line");

	return {
		chat,
		inFlight,
		status,
		widgetAbove,
		editor,
		chrome,
		footer,
		setMode(label) {
			chrome.setModeLabel(label);
		},
		setTopic(label) {
			chrome.setTopicLabel(label);
		},
		setInFlightLines(lines) {
			while (inFlight.children.length > 0) {
				inFlight.removeChild(inFlight.children[0]!);
			}
			for (const line of lines) {
				inFlight.addChild(new Text(`STICKY_CARD ${line}`, 0, 0));
			}
		},
		setThinkingLine(text) {
			status.setText(text);
		},
	};
}
