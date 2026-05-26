/**
 * Unit tests for StreamingZone — segment lifecycle without a running TUI.
 */
import { Container } from "@dpopsuev/alef-tui";
import { describe, expect, it } from "vitest";
import { getTheme } from "../src/theme.js";
import { AgentBlock } from "../src/tui/chat-view.js";
import { StreamingZone } from "../src/tui/streaming-zone.js";

function makeZone() {
	const chat = new Container();
	const agent = new AgentBlock(chat, getTheme());
	agent.start();
	const zone = new StreamingZone(agent, () => {}, getTheme());
	return { chat, agent, zone };
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
