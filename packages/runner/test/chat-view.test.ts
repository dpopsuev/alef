/**
 * Unit tests for chat-view.ts — UserBlock, AgentBlock, NoticeBlock.
 * No TUI process needed; tests DOM structure directly.
 */
import { Container } from "@dpopsuev/alef-tui";
import { describe, expect, it } from "vitest";
import { AgentBlock, appendNotice, appendUserMsg } from "../src/tui/chat-view.js";

function makeChat() {
	return new Container();
}

describe("appendUserMsg", () => {
	it("adds children to the chat container", () => {
		const chat = makeChat();
		appendUserMsg(chat, "hello world");
		// Spacer + header DynamicText + Box + footer DynamicText + Spacer = 5
		expect(chat.children.length).toBe(5);
	});

	it("does not throw for multi-line text", () => {
		const chat = makeChat();
		expect(() => appendUserMsg(chat, "line1\nline2\nline3")).not.toThrow();
	});
});

describe("appendNotice", () => {
	it("adds children to the chat container", () => {
		const chat = makeChat();
		appendNotice(chat, "(interrupted)");
		// Spacer + header + Text + footer + Spacer = 5
		expect(chat.children.length).toBe(5);
	});
});

describe("AgentBlock", () => {
	it("start() is idempotent — calling twice adds header only once", () => {
		const chat = makeChat();
		const block = new AgentBlock(chat);
		block.start();
		const countAfterFirst = chat.children.length;
		block.start(); // no-op
		expect(chat.children.length).toBe(countAfterFirst);
		expect(block.isOpen).toBe(true);
	});

	it("end() adds footer and closes block", () => {
		const chat = makeChat();
		const block = new AgentBlock(chat);
		block.start();
		const beforeEnd = chat.children.length;
		block.end();
		expect(chat.children.length).toBeGreaterThan(beforeEnd); // footer added
		expect(block.isOpen).toBe(false);
	});

	it("end() is idempotent when already closed", () => {
		const chat = makeChat();
		const block = new AgentBlock(chat);
		block.start();
		block.end();
		const countAfterEnd = chat.children.length;
		block.end(); // no-op
		expect(chat.children.length).toBe(countAfterEnd);
	});

	it("addContent() routes to contentBox when open", () => {
		const chat = makeChat();
		const block = new AgentBlock(chat);
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
		const block = new AgentBlock(chat);
		const { Text } = require("@dpopsuev/alef-tui") as typeof import("@dpopsuev/alef-tui");
		const item = new Text("notice", 1, 0);
		block.addContent(item);
		expect(chat.children).toContain(item);
	});

	it("reset() clears open state without adding footer", () => {
		const chat = makeChat();
		const block = new AgentBlock(chat);
		block.start();
		const countAfterStart = chat.children.length;
		block.reset();
		expect(block.isOpen).toBe(false);
		// No footer added — count unchanged
		expect(chat.children.length).toBe(countAfterStart);
	});

	it("can be reopened after reset()", () => {
		const chat = makeChat();
		const block = new AgentBlock(chat);
		block.start();
		block.reset();
		block.start(); // should work again
		expect(block.isOpen).toBe(true);
	});
});
