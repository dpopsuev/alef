import { Container } from "@dpopsuev/alef-tui";
import { describe, expect, it } from "vitest";
import { getTheme } from "../src/theme.js";
import { StreamingZone } from "../src/tui/streaming-zone.js";

function makeZone(hideThinking = false) {
	const chat = new Container();
	const zone = new StreamingZone(chat, () => {}, getTheme(), hideThinking);
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

	it("reset clears pointers; pill content stays in chat", () => {
		const { zone, chat } = makeZone();
		zone.receiveText("some text");
		zone.reset();
		expect(zone.markdownNode).toBeNull();
		expect(chat.children.length).toBeGreaterThan(0);
	});

	it("clear leaves pill footer in chat on abort", () => {
		const { zone, chat } = makeZone();
		zone.receiveText("chunk");
		zone.clear();
		expect(zone.markdownNode).toBeNull();
		expect(chat.children.length).toBeGreaterThan(0);
	});

	it("receiveThinking creates a think node with accumulated text", () => {
		const { zone } = makeZone(false);
		zone.receiveThinking("interesting thought");
		expect(zone.thinkNode).not.toBeNull();
		expect(zone.thinkNode?.getText()).toBe("interesting thought");
	});

	it("reset on empty zone is a no-op", () => {
		const { chat, zone } = makeZone();
		expect(() => zone.reset()).not.toThrow();
		expect(chat.children.length).toBe(0);
	});

	it("after reset new text opens a new pill block", () => {
		const { zone } = makeZone();
		zone.receiveText("before tool");
		zone.reset();
		zone.receiveText("after tool");
		expect(zone.markdownNode?.getText()).toBe("after tool");
	});
});

describe("thinking label", () => {
	it("stampThinkingLabel is safe when no thinking occurred", () => {
		const { zone } = makeZone();
		expect(() => zone.stampThinkingLabel()).not.toThrow();
	});

	it("stampThinkingLabel updates the header text", () => {
		const { zone } = makeZone(false);
		zone.receiveThinking("reasoning");
		zone.stampThinkingLabel();
		expect(zone.thinkNode).not.toBeNull();
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
