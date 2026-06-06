/**
 * Unit tests for chat-view.ts — UserBlock, AgentBlock, NoticeBlock.
 * No TUI process needed; tests DOM structure directly.
 */
import { stripVTControlCharacters } from "node:util";
import { Container, visibleWidth } from "@dpopsuev/alef-tui";
import { describe, expect, it } from "vitest";
import { getTheme } from "../src/theme.js";
import { AgentBlock, appendCompletedToolBlock, appendNotice, appendUserMsg } from "../src/tui/chat-view.js";

function makeChat() {
	return new Container();
}

describe("appendUserMsg", { tags: ["unit"] }, () => {
	it("adds children to the chat container", () => {
		const chat = makeChat();
		appendUserMsg(chat, "hello world", getTheme());
		// Spacer + header DynamicText + Box + footer DynamicText = 4
		expect(chat.children.length).toBe(4);
	});

	it("does not throw for multi-line text", () => {
		const chat = makeChat();
		expect(() => appendUserMsg(chat, "line1\nline2\nline3", getTheme())).not.toThrow();
	});
});

describe("appendNotice", { tags: ["unit"] }, () => {
	it("adds children to the chat container", () => {
		const chat = makeChat();
		appendNotice(chat, "(interrupted)", getTheme());
		// Spacer + header + Text + footer = 4
		expect(chat.children.length).toBe(4);
	});
});

describe("AgentBlock", { tags: ["unit"] }, () => {
	it("start() is idempotent — calling twice adds header only once", () => {
		const chat = makeChat();
		const block = new AgentBlock(chat, getTheme());
		block.start();
		const countAfterFirst = chat.children.length;
		block.start(); // no-op
		expect(chat.children.length).toBe(countAfterFirst);
		expect(block.isOpen).toBe(true);
	});

	it("end() adds footer and closes block", () => {
		const chat = makeChat();
		const block = new AgentBlock(chat, getTheme());
		block.start();
		const beforeEnd = chat.children.length;
		block.end();
		expect(chat.children.length).toBeGreaterThan(beforeEnd); // footer added
		expect(block.isOpen).toBe(false);
	});

	it("end() is idempotent when already closed", () => {
		const chat = makeChat();
		const block = new AgentBlock(chat, getTheme());
		block.start();
		block.end();
		const countAfterEnd = chat.children.length;
		block.end(); // no-op
		expect(chat.children.length).toBe(countAfterEnd);
	});

	it("addContent() routes to contentBox when open", () => {
		const chat = makeChat();
		const block = new AgentBlock(chat, getTheme());
		block.start();
		const { Text } = require("@dpopsuev/alef-tui") as typeof import("@dpopsuev/alef-tui");
		const item = new Text("tool output", 1, 0);
		block.addContent(item);
		// item should NOT be a direct child of chat (it's inside contentBox)
		expect(chat.children).not.toContain(item);
		block.end();
	});

	it("addContent() routes to chat directly when not open", () => {
		const chat = makeChat();
		const block = new AgentBlock(chat, getTheme());
		const { Text } = require("@dpopsuev/alef-tui") as typeof import("@dpopsuev/alef-tui");
		const item = new Text("notice", 1, 0);
		block.addContent(item);
		expect(chat.children).toContain(item);
	});

	it("reset() clears open state without adding footer", () => {
		const chat = makeChat();
		const block = new AgentBlock(chat, getTheme());
		block.start();
		const countAfterStart = chat.children.length;
		block.reset();
		expect(block.isOpen).toBe(false);
		// No footer added — count unchanged
		expect(chat.children.length).toBe(countAfterStart);
	});

	it("can be reopened after reset()", () => {
		const chat = makeChat();
		const block = new AgentBlock(chat, getTheme());
		block.start();
		block.reset();
		block.start(); // should work again
		expect(block.isOpen).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// appendCompletedToolBlock — pill header width invariant
// ALE-BUG: header was off by one (fill used -4 instead of -5), causing
// "Rendered line N exceeds terminal width" crash in TUI.doRender.
// ---------------------------------------------------------------------------

describe("appendCompletedToolBlock — pill header width", { tags: ["unit"] }, () => {
	const t = getTheme();

	function renderHeader(width: number, name: string, keyArg: string, elapsedMs: number): string {
		const chat = new Container();
		appendCompletedToolBlock(chat, name, keyArg, elapsedMs, true, null, t);
		// First child is the header DynamicText
		const header = chat.children[0] as unknown as { render(w: number): string[] };
		const lines = header.render(width);
		return lines[0] ?? "";
	}

	for (const width of [80, 120, 179, 200]) {
		it(`header visible width === terminal width at w=${width}`, () => {
			const line = renderHeader(width, "fs.find", "*", 29);
			const visible = visibleWidth(stripVTControlCharacters(line));
			expect(visible).toBe(width);
		});
	}

	it("header visible width === terminal width with long tool name", () => {
		const width = 120;
		const line = renderHeader(width, "shell.exec", "npm run build --verbose", 1234);
		const visible = visibleWidth(stripVTControlCharacters(line));
		expect(visible).toBe(width);
	});

	it("header visible width === terminal width with no keyArg", () => {
		const width = 80;
		const line = renderHeader(width, "nodesh.eval", "", 5);
		const visible = visibleWidth(stripVTControlCharacters(line));
		expect(visible).toBe(width);
	});
});
