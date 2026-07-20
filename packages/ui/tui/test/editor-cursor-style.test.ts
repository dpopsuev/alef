/**
 * Editor cursor style and blink tests.
 *
 * Verifies block/line cursor rendering and blink toggle behavior.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
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

function hasLineChar(editor: Editor, width = 80): boolean {
	const raw = editor.render(width);
	return raw.some((line) => line.includes("\u2502"));
}

describe("Editor cursor style", { tags: ["unit"] }, () => {
	it("defaults to block cursor", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		expect(editor.cursorStyle).toBe("block");
		editor.focused = true;
		expect(hasInverseCursor(editor)).toBe(true);
	});

	it("renders block cursor as inverse video", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.focused = true;
		editor.cursorStyle = "block";
		const raw = editor.render(80);
		const cursorLine = raw.find((l) => l.includes("\x1b[7m"));
		expect(cursorLine).toBeDefined();
		// Block cursor on empty line renders an inverse space
		expect(cursorLine).toContain("\x1b[7m \x1b[0m");
	});

	it("renders line cursor with vertical bar character", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.focused = true;
		editor.cursorStyle = "line";
		expect(hasLineChar(editor)).toBe(true);
	});

	it("line cursor on text uses inverse bar before character", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.focused = true;
		editor.cursorStyle = "line";
		editor.handleInput("hello");
		// Move cursor to start
		editor.handleInput("\x1b[H"); // Home
		const raw = editor.render(80);
		const cursorLine = raw.find((l) => l.includes("\u2502"));
		expect(cursorLine).toBeDefined();
	});

	it("switching style changes rendering immediately", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.focused = true;

		editor.cursorStyle = "block";
		expect(hasInverseCursor(editor)).toBe(true);

		editor.cursorStyle = "line";
		expect(hasLineChar(editor)).toBe(true);

		editor.cursorStyle = "block";
		expect(hasInverseCursor(editor)).toBe(true);
	});
});

describe("Editor cursor blink", { tags: ["unit"] }, () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("defaults to no blink", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		expect(editor.cursorBlink).toBe(false);
	});

	it("cursor always visible when blink is off", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.focused = true;
		editor.cursorBlink = false;
		expect(hasInverseCursor(editor)).toBe(true);
		expect(hasInverseCursor(editor)).toBe(true);
	});

	it("startBlink does nothing when cursorBlink is false", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.cursorBlink = false;
		editor.startBlink();
		// No timer should be set, cursor should remain visible
		editor.focused = true;
		expect(hasInverseCursor(editor)).toBe(true);
		editor.stopBlink();
	});

	it("startBlink creates timer when cursorBlink is true", () => {
		vi.useFakeTimers();
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.focused = true;
		editor.cursorBlink = true;
		editor.startBlink();

		// Initially visible
		expect(hasInverseCursor(editor)).toBe(true);

		// After one interval, should toggle
		vi.advanceTimersByTime(530);
		expect(hasInverseCursor(editor)).toBe(false);

		// After another interval, should toggle back
		vi.advanceTimersByTime(530);
		expect(hasInverseCursor(editor)).toBe(true);

		editor.stopBlink();
		vi.useRealTimers();
	});

	it("stopBlink resets cursor to visible", () => {
		vi.useFakeTimers();
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.focused = true;
		editor.cursorBlink = true;
		editor.startBlink();

		vi.advanceTimersByTime(530); // Toggle to invisible
		expect(hasInverseCursor(editor)).toBe(false);

		editor.stopBlink();
		expect(hasInverseCursor(editor)).toBe(true);

		vi.useRealTimers();
	});

	it("typing resets blink to visible", () => {
		vi.useFakeTimers();
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.focused = true;
		editor.cursorBlink = true;
		editor.startBlink();

		vi.advanceTimersByTime(530); // Toggle to invisible
		expect(hasInverseCursor(editor)).toBe(false);

		editor.handleInput("a");
		expect(hasInverseCursor(editor)).toBe(true);

		editor.stopBlink();
		vi.useRealTimers();
	});
});
