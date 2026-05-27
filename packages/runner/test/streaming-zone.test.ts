/**
 * Unit tests for StreamingZone — segment lifecycle without a running TUI.
 */
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
	it("receiveText() creates an active segment and markdown node", () => {
		const { zone } = makeZone();
		zone.receiveText("hello");
		expect(zone.activeSegment).not.toBeNull();
		expect(zone.markdownNode).not.toBeNull();
	});

	it("receiveText() accumulates chunks in the typewriter", () => {
		const { zone } = makeZone();
		zone.receiveText("hello");
		zone.receiveText(" world");
		expect(zone.replyTypewriter.pendingText).toBe("hello world");
	});

	it("seal() resets active segment and markdown node", () => {
		const { zone } = makeZone();
		zone.receiveText("some text");
		zone.seal();
		expect(zone.activeSegment).toBeNull();
		expect(zone.markdownNode).toBeNull();
	});

	it("seal() flushes the typewriter before resetting", () => {
		const { zone } = makeZone();
		zone.receiveText("pending content");
		expect(zone.replyTypewriter.pendingText.length).toBeGreaterThan(0);
		zone.seal();
		expect(zone.replyTypewriter.pendingText.length).toBe(0);
	});

	it("clear() removes all segments", () => {
		const { zone } = makeZone();
		zone.receiveText("chunk1");
		zone.seal();
		zone.receiveText("chunk2");
		expect(zone.segments.length).toBeGreaterThan(0);
		zone.clear();
		expect(zone.segments.length).toBe(0);
		expect(zone.activeSegment).toBeNull();
	});

	it("seal() on empty segment removes it (ALE-BUG-7 fix)", () => {
		const { zone } = makeZone();
		// Manually open a segment without adding content via receiveText
		// so no markdown/think node is created — simulates a tool-only turn
		zone.activeSegment = new Container();
		zone.segments.push(zone.activeSegment);
		const segsBefore = zone.segments.length;
		zone.seal();
		expect(zone.segments.length).toBeLessThan(segsBefore);
	});

	it("receiveThinking() creates a think node", () => {
		const { zone } = makeZone();
		zone.receiveThinking("interesting thought");
		expect(zone.thinkNode).not.toBeNull();
		expect(zone.thinkTypewriter.pendingText).toBe("interesting thought");
	});

	it("multiple seal() calls are safe", () => {
		const { zone } = makeZone();
		zone.receiveText("hi");
		zone.seal();
		expect(() => zone.seal()).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// Pending footer lifecycle
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Thinking content visibility after seal (ALE-BUG fix: was collapsed to label)
// ---------------------------------------------------------------------------

describe("thinking content after seal", () => {
	it("seal() leaves thinking content in the segment tree — not replaced with compact label", () => {
		const { zone } = makeZone();
		zone.receiveThinking("The answer is 42 because of deep philosophical reasons.");
		zone.thinkTypewriter.flush();
		zone.seal();
		// The segment container still holds children (header + content node).
		// Compact-label behavior would have replaced the Markdown with a one-liner;
		// instead the segment should have 2 children: header Text + content Markdown.
		const seg = zone.segments[0];
		expect(seg).toBeDefined();
		expect(seg!.children.length).toBe(2); // header + content
		// Content was flushed into the Markdown node by seal() — pendingText is consumed.
		// The key invariant: 2 children (header + Markdown), not 1 (compact label Text).
	});

	it("seal() resets thinkNode pointer (correct) while keeping segment content", () => {
		const { zone } = makeZone();
		zone.receiveThinking("some reasoning");
		zone.thinkTypewriter.flush();
		zone.seal();
		// thinkNode is reset to null — correct, so next receiveThinking opens a fresh node.
		// The content remains in segments[0].children.
		expect(zone.thinkNode).toBeNull();
		expect(zone.segments[0]!.children.length).toBe(2);
	});

	it("thinking content survives across a tool call seal+reopen cycle", () => {
		const { zone } = makeZone();
		zone.receiveThinking("pre-tool thought");
		zone.thinkTypewriter.flush();
		zone.seal(); // first seal (before tool call)
		zone.receiveText("post-tool reply");
		zone.replyTypewriter.flush();
		zone.seal(); // second seal
		// Original thinkNode from segment 0 still has content
		expect(zone.segments.length).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// formatTokenUsage with total turn time
// ---------------------------------------------------------------------------

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
