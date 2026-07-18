/**
 * Unit tests for chat-view.ts — UserMsg, AgentBlock, Notice, ToolBlock.
 * No TUI process needed; tests DOM structure directly.
 */
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import { Text } from "../../src/components/text.js";
import type { ThemeTokens } from "../../src/theme-types.js";
import { Container } from "../../src/tui.js";
import {
	AgentBlock,
	appendCompletedToolBlock,
	appendNotice,
	appendUserMsg,
} from "../../src/views/chat-view.js";
import { INDENT } from "../../src/views/layout-constants.js";
import { makeToolOutputComponent } from "../../src/views/tool-view.js";

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
		brightFg: C,
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

	it("colors only the speaker label, not the message body", () => {
		const chat = makeChat();
		const theme = getTheme();
		theme.userFg = { ansi16: 95 };
		appendUserMsg(chat, "plain body text", theme, "dpopsuev");

		const labelLine = chat.children[1]!.render(40).join("\n");
		expect(labelLine).toContain("\x1b[");
		expect(labelLine).toContain("dpopsuev");

		const bodyLine = chat.children[2]!.render(40).join("\n");
		expect(bodyLine).toContain("plain body text");
		expect(bodyLine).not.toContain("\x1b[");
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

	it("aligns tool line and tool output with agent body on the content column", () => {
		const chat = makeChat();
		const theme = getTheme();
		const block = new AgentBlock(chat, theme, "rosewood");
		block.start();
		block.addContent(new Text("Plan is open with 10 steps.", 0, 0));
		block.end();

		appendCompletedToolBlock(
			chat,
			"plan.steps",
			"",
			{ steps: [1, 2] },
			33,
			true,
			makeToolOutputComponent("Added 10 step(s): implement python", undefined, theme),
			theme,
		);

		const lines = chat.render(80).map((line) => stripVTControlCharacters(line));
		const prose = lines.find((line) => line.includes("Plan is open"));
		const tool = lines.find((line) => line.includes("plan.steps"));
		const output = lines.find((line) => line.includes("Added 10 step(s)"));
		expect(prose, lines.join("\n")).toBeDefined();
		expect(tool, lines.join("\n")).toBeDefined();
		expect(output, lines.join("\n")).toBeDefined();

		const leading = (line: string) => line.match(/^ */)?.[0]?.length ?? 0;
		expect(leading(prose!)).toBe(INDENT.BLOCK);
		expect(leading(tool!)).toBe(INDENT.TOOL_LINE);
		expect(leading(output!)).toBe(INDENT.TOOL_OUTPUT);
		expect(INDENT.TOOL_LINE).toBe(INDENT.BLOCK);
		expect(INDENT.TOOL_OUTPUT).toBe(INDENT.BLOCK);
	});
});
