/**
 * Editor cursor suppression tests.
 *
 * When suppressCursor=true and the editor is empty, the inverse-video
 * cursor block should not render. Typing makes it reappear immediately.
 */
import { describe, expect, it } from "vitest";
import { Editor } from "../src/components/editor.js";
import { TUI } from "../src/tui.js";
import { defaultEditorTheme } from "./test-themes.js";
import { VirtualTerminal } from "./virtual-terminal.js";

function createTestTUI(cols = 80, rows = 24): TUI {
	return new TUI(new VirtualTerminal(cols, rows));
}

function hasInverseCursor(editor: Editor, width = 80): boolean {
	const raw = editor.render(width);
	return raw.some((line) => line.includes("\x1b[7m"));
}

describe("Editor cursor suppression", { tags: ["unit"] }, () => {
	it("shows cursor by default when editor is empty", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.focused = true;
		expect(hasInverseCursor(editor)).toBe(true);
	});

	it("hides cursor when suppressCursor=true and editor is empty", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.focused = true;
		editor.suppressCursor = true;
		expect(hasInverseCursor(editor)).toBe(false);
	});

	it("shows cursor when suppressCursor=true but editor has content", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.focused = true;
		editor.suppressCursor = true;
		editor.handleInput("h");
		expect(hasInverseCursor(editor)).toBe(true);
	});

	it("cursor reappears when user types during suppression", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.focused = true;
		editor.suppressCursor = true;
		expect(hasInverseCursor(editor)).toBe(false);

		editor.handleInput("a");
		expect(hasInverseCursor(editor)).toBe(true);
	});

	it("cursor reappears when suppressCursor is cleared", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.focused = true;
		editor.suppressCursor = true;
		expect(hasInverseCursor(editor)).toBe(false);

		editor.suppressCursor = false;
		expect(hasInverseCursor(editor)).toBe(true);
	});

	it("non-empty editor always shows cursor regardless of suppressCursor", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.focused = true;
		editor.setText("hello");

		editor.suppressCursor = false;
		expect(hasInverseCursor(editor)).toBe(true);

		editor.suppressCursor = true;
		expect(hasInverseCursor(editor)).toBe(true);
	});

	it("suppressCursor=true hides cursor on empty editor even when unfocused", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.focused = false;
		editor.suppressCursor = true;
		expect(hasInverseCursor(editor)).toBe(false);
	});
});
