/**
 * Unit tests for chat-view.ts — UserMsg, AgentBlock, Notice, ToolBlock.
 * No TUI process needed; tests DOM structure directly.
 */
import { Container } from "@dpopsuev/alef-tui/views";
import { describe, expect, it } from "vitest";
import { getTheme } from "../src/theme.js";
import { AgentBlock, appendCompletedToolBlock, appendNotice, appendUserMsg } from "@dpopsuev/alef-tui/views";

function makeChat() {
	return new Container();
}

describe("appendUserMsg", { tags: ["unit"] }, () => {
	it("adds children to the chat container", () => {
		const chat = makeChat();
		appendUserMsg(chat, "hello world", getTheme());
		// Spacer + label Text + Pad(content) = 3
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
		// Spacer + Text = 2
		expect(chat.children.length).toBe(2);
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
		block.end(); // no-op
		expect(chat.children.length).toBe(countAfterEnd);
	});

	it("addContent() routes to contentPad when open", () => {
		const chat = makeChat();
		const block = new AgentBlock(chat, getTheme());
		block.start();
		const { Text } = require("@dpopsuev/alef-tui/views") as typeof import("@dpopsuev/alef-tui/views");
		const item = new Text("tool output", 1, 0);
		block.addContent(item);
		expect(chat.children).not.toContain(item);
		block.end();
	});

	it("addContent() routes to chat directly when not open", () => {
		const chat = makeChat();
		const block = new AgentBlock(chat, getTheme());
		const { Text } = require("@dpopsuev/alef-tui/views") as typeof import("@dpopsuev/alef-tui/views");
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
		appendCompletedToolBlock(chat, "fs.read", "README.md", 42, true, null, getTheme());
		expect(chat.children.length).toBe(1);
	});

	it("adds status line + output when display provided", () => {
		const chat = makeChat();
		const { Text } = require("@dpopsuev/alef-tui/views") as typeof import("@dpopsuev/alef-tui/views");
		const output = new Text("file contents", 2, 0);
		appendCompletedToolBlock(chat, "fs.read", "README.md", 42, true, output, getTheme());
		// status line + Pad(output) = 2
		expect(chat.children.length).toBe(2);
	});
});
