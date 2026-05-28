import { Container } from "@dpopsuev/alef-tui";
import { describe, expect, it } from "vitest";
import { getTheme } from "../src/theme.js";
import { StreamingZone } from "../src/tui/streaming-zone.js";

function makeZone(hideThinking = false) {
	const chat = new Container();
	const zone = new StreamingZone(
		chat,
		() => {},
		getTheme(),
		() => {},
		hideThinking,
	);
	return { chat, zone };
}

describe("StreamingZone", () => {
	it("receiveText creates a markdown node", () => {
		const { zone } = makeZone();
		zone.receiveText("hello");
		expect(zone.markdownNode).not.toBeNull();
	});

	it("receiveText accumulates chunks in the markdown node", () => {
		const { zone } = makeZone();
		zone.receiveText("hello");
		zone.receiveText(" world");
		expect(zone.markdownNode?.getText()).toBe("hello world");
	});

	it("seal resets markdownNode and thinkNode", () => {
		const { zone } = makeZone();
		zone.receiveText("some text");
		zone.seal();
		expect(zone.markdownNode).toBeNull();
		expect(zone.thinkNode).toBeNull();
	});

	it("seal resets accumulated text", () => {
		const { zone } = makeZone();
		zone.receiveText("pending content");
		expect(zone.markdownNode).not.toBeNull();
		zone.seal();
		expect(zone.markdownNode).toBeNull();
	});

	it("content added before seal stays in chat", () => {
		const { zone, chat } = makeZone();
		zone.receiveText("chunk1");
		const childsBefore = chat.children.length;
		zone.seal();
		expect(chat.children.length).toBe(childsBefore);
	});

	it("clear removes all wrappers from chat", () => {
		const { zone, chat } = makeZone();
		zone.receiveText("chunk1");
		zone.seal();
		zone.receiveText("chunk2");
		const childsBefore = chat.children.length;
		expect(childsBefore).toBeGreaterThan(0);
		zone.clear();
		expect(chat.children.length).toBe(0);
		expect(zone.markdownNode).toBeNull();
	});

	it("receiveThinking creates a think node", () => {
		const { zone } = makeZone(false);
		zone.receiveThinking("interesting thought");
		expect(zone.thinkNode).not.toBeNull();
		expect(zone.thinkNode?.getText()).toBe("interesting thought");
	});

	it("multiple seal calls are safe", () => {
		const { zone } = makeZone();
		zone.receiveText("hi");
		zone.seal();
		expect(() => zone.seal()).not.toThrow();
	});

	it("seal on empty zone is a no-op", () => {
		const { chat, zone } = makeZone();
		expect(() => zone.seal()).not.toThrow();
		expect(chat.children.length).toBe(0);
	});

	it("two seals produce two separate wrappers in chat", () => {
		const { zone, chat } = makeZone();
		zone.receiveText("pre-tool");
		zone.seal();
		zone.receiveText("post-tool");
		zone.seal();
		expect(chat.children.length).toBe(2);
	});
});

describe("thinking content after seal", () => {
	it("thinking content stays in chat after seal", () => {
		const { zone, chat } = makeZone(false);
		zone.receiveThinking("deep reasoning");
		zone.seal();
		expect(chat.children.length).toBeGreaterThan(0);
		expect(zone.thinkNode).toBeNull();
	});

	it("thinking and reply survive across a seal+reopen cycle", () => {
		const { zone, chat } = makeZone(false);
		zone.receiveThinking("pre-tool thought");
		zone.seal();
		zone.receiveText("post-tool reply");
		zone.seal();
		expect(chat.children.length).toBe(2);
	});
});

import { formatTokenUsage } from "../src/tui/tool-view.js";

describe("formatTokenUsage", () => {
	const t = getTheme();

	it("omits timing when turnMs not provided", () => {
		const out = formatTokenUsage(1000, 500, t);
		expect(out).toContain("in");
		expect(out).toContain("out");
		expect(out).not.toContain("s");
	});

	it("includes total time when turnMs provided", () => {
		const out = formatTokenUsage(1000, 500, t, 14200);
		expect(out).toContain("14.2s");
	});

	it("formats sub-1k token counts as plain numbers", () => {
		const out = formatTokenUsage(7, 3, t, 1000);
		expect(out).toContain("7");
		expect(out).toContain("3");
	});

	it("formats 1k+ token counts with k suffix", () => {
		const out = formatTokenUsage(7000, 1000, t);
		expect(out).toContain("7.0k");
		expect(out).toContain("1.0k");
	});
});
