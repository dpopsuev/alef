/**
 * Unit tests for chat-view.ts — UserMsg, AgentBlock, Notice, ToolBlock.
 * No TUI process needed; tests DOM structure directly.
 */
import { describe, expect, it } from "vitest";
import { Text } from "../../src/components/text.js";
import type { ThemeTokens } from "../../src/theme-types.js";
import { Container } from "../../src/tui.js";
import { AgentBlock, appendCompletedToolBlock, appendNotice, appendUserMsg } from "../../src/views/chat-view.js";

const C = { ansi16: 37 };
function getTheme(): ThemeTokens {
	return {
		userFg: C,
		userBg: C,
		agentFg: C,
		agentBg: C,
		primaryFg: C,
		secondaryFg: C,
		mutedFg: C,
		accentFg: C,
		okFg: C,
		warnFg: C,
		errFg: C,
	};
}

function makeChat() {
	return new Container();
}

describe("appendUserMsg", { tags: ["unit"] }, () => {
	it("adds children to the chat container", () => {
		const chat = makeChat();
		appendUserMsg(chat, "hello world", getTheme());
		expect(chat.children.length).toBe(3);
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
		expect(chat.children.length).toBe(2);
	});
});

describe("AgentBlock", { tags: ["unit"] }, () => {
	it("start() is idempotent — calling twice adds header only once", () => {
		const chat = makeChat();
		const block = new AgentBlock(chat, getTheme());
		block.start();
		const countAfterFirst = chat.children.length;
		block.start();
		expect(chat.children.length).toBe(countAfterFirst);
		expect(block.isOpen).toBe(true);
	});

	it("end() closes block without adding footer", () => {
		const chat = makeChat();
		const block = new AgentBlock(chat, getTheme());
		block.start();
		const beforeEnd = chat.children.length;
		block.end();
		expect(chat.children.length).toBe(beforeEnd);
		expect(block.isOpen).toBe(false);
	});

	it("end() is idempotent when already closed", () => {
		const chat = makeChat();
		const block = new AgentBlock(chat, getTheme());
		block.start();
		block.end();
		const countAfterEnd = chat.children.length;
		block.end();
		expect(chat.children.length).toBe(countAfterEnd);
	});

	it("addContent() routes to contentPad when open", () => {
		const chat = makeChat();
		const block = new AgentBlock(chat, getTheme());
		block.start();
		const item = new Text("tool output", 1, 0);
		block.addContent(item);
		expect(chat.children).not.toContain(item);
		block.end();
	});

	it("addContent() routes to chat directly when not open", () => {
		const chat = makeChat();
		const block = new AgentBlock(chat, getTheme());
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
		expect(chat.children.length).toBe(countAfterStart);
	});

	it("can be reopened after reset()", () => {
		const chat = makeChat();
		const block = new AgentBlock(chat, getTheme());
		block.start();
		block.reset();
		block.start();
		expect(block.isOpen).toBe(true);
	});
});

describe("appendCompletedToolBlock", { tags: ["unit"] }, () => {
	it("adds a status line to the container", () => {
		const chat = makeChat();
		appendCompletedToolBlock(chat, "fs.read", "README.md", { path: "README.md" }, 42, true, null, getTheme());
		expect(chat.children.length).toBe(1);
	});

	it("adds status line + output when display provided", () => {
		const output = new Text("file contents", 2, 0);
		const chat = makeChat();
		appendCompletedToolBlock(chat, "fs.read", "README.md", { path: "README.md" }, 42, true, output, getTheme());
		expect(chat.children.length).toBe(2);
	});
});
