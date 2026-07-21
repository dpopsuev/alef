/**
 * Dispatch pipeline invariant tests.
 *
 * Tests computeDispatch() as a pure function: feed events, assert on intents.
 * Following Ghostty's pattern: test the state machine, not the renderer.
 * Following Hashimoto's principle: test behavior at the right abstraction level.
 *
 * These tests caught actual bugs:
 *   - tool-start resets reply block, destroying accumulated streaming text
 *   - showInFlightCall doesn't clear statusText synchronously (race with spinner)
 */

import { describe, expect, it } from "vitest";
import { computeDispatch, type DispatchContext, type DispatchEvent } from "../src/client/events.js";
import type { RenderIntent } from "../src/client/render-intent.js";
import { type DispatchState, initialDispatchState } from "../src/client/state.js";
import { getTheme } from "../src/client/theme.js";

const THEME = getTheme();

function ctx(overrides: Partial<DispatchContext> = {}): DispatchContext {
	return {
		t: THEME,
		hideThinking: true,
		...overrides,
	};
}

/** Feed a sequence of events through computeDispatch, collecting all intents. */
function dispatchSequence(
	events: DispatchEvent[],
	context?: DispatchContext,
): { state: DispatchState; allIntents: RenderIntent[][]; finalIntents: RenderIntent[] } {
	let state = initialDispatchState();
	const allIntents: RenderIntent[][] = [];
	for (const event of events) {
		const result = computeDispatch(state, event, context ?? ctx());
		state = result.state;
		allIntents.push(result.intents);
	}
	return { state, allIntents, finalIntents: allIntents[allIntents.length - 1] ?? [] };
}

/** Extract intents of a specific kind from an intent list. */
function intentsByKind<K extends RenderIntent["kind"]>(intents: RenderIntent[], kind: K): RenderIntent[] {
	return intents.filter((i) => i.kind === kind);
}

/** Check if an intent list contains a specific kind. */
function hasIntent(intents: RenderIntent[], kind: RenderIntent["kind"]): boolean {
	return intents.some((i) => i.kind === kind);
}

// ---------------------------------------------------------------------------
// 1. tool-start should NOT reset the reply block
// ---------------------------------------------------------------------------

describe("tool-start intent sequence", { tags: ["unit"] }, () => {
	it("tool-start emits reset-reply-block, destroying accumulated text (BUG)", () => {
		// Scenario: LLM streams text, then a tool call starts.
		// The reply block should NOT be reset -- the streamed text should persist.
		const events: DispatchEvent[] = [
			{ type: "turn.start", timestamp: Date.now() },
			{ type: "chunk", text: "Here is some analysis..." },
			{ type: "chunk", text: " and more text continues" },
			{
				type: "tool-start",
				callId: "call-1",
				name: "shell.exec",
				args: { command: "npm test" },
			},
		];

		const { allIntents } = dispatchSequence(events);
		const toolStartIntents = allIntents[3]!;

		// BUG: tool-start currently emits reset-reply-block via emitResetUI().
		// This destroys the streamed text that was accumulated in chunks 1-2.
		// The reply block should NOT be reset on tool-start.
		const hasReset = hasIntent(toolStartIntents, "reset-reply-block");

		// Flushing the typewriter is fine -- it completes pending animation.
		// But resetting the reply block destroys content.
		// This test documents the bug. After fix, change to expect(hasReset).toBe(false).
		expect(hasReset, "tool-start should not reset reply block (destroys streamed text)").toBe(true);
		expect(hasIntent(toolStartIntents, "flush-reply-tw"), "tool-start should flush typewriter").toBe(true);
	});

	it("tool-start always flushes typewriter (correct behavior)", () => {
		const events: DispatchEvent[] = [
			{ type: "turn.start", timestamp: Date.now() },
			{ type: "chunk", text: "streaming text" },
			{
				type: "tool-start",
				callId: "call-1",
				name: "fs.read",
				args: { path: "file.ts" },
			},
		];

		const { allIntents } = dispatchSequence(events);
		const toolStartIntents = allIntents[2]!;

		expect(hasIntent(toolStartIntents, "flush-reply-tw"), "tool-start should flush typewriter").toBe(true);
	});

	it("multiple tool-starts emit multiple reset-reply-blocks (compounding bug)", () => {
		const events: DispatchEvent[] = [
			{ type: "turn.start", timestamp: Date.now() },
			{ type: "chunk", text: "analysis text" },
			{ type: "tool-start", callId: "c1", name: "fs.read", args: { path: "a.ts" } },
			{ type: "tool-start", callId: "c2", name: "fs.read", args: { path: "b.ts" } },
			{ type: "tool-start", callId: "c3", name: "shell.exec", args: { command: "ls" } },
		];

		const { allIntents } = dispatchSequence(events);

		// Each tool-start resets the reply block independently
		let resetCount = 0;
		for (const intents of allIntents) {
			resetCount += intentsByKind(intents, "reset-reply-block").length;
		}

		// BUG: 3 resets for 3 tool-starts. First reset destroys the streamed text.
		// Subsequent resets are redundant but harmless (block is already empty).
		expect(resetCount, "each tool-start resets the reply block").toBe(3);
	});
});

// ---------------------------------------------------------------------------
// 2. chunk after tool-start creates orphaned content
// ---------------------------------------------------------------------------

describe("chunk after tool-start", { tags: ["unit"] }, () => {
	it("chunk arriving after tool-start still emits reply-chunk intent", () => {
		// This is the "text restarts" scenario: tool starts, then more chunks arrive
		// (e.g., from a queued assistant message or streaming continuation).
		const events: DispatchEvent[] = [
			{ type: "turn.start", timestamp: Date.now() },
			{ type: "chunk", text: "before tool" },
			{ type: "tool-start", callId: "c1", name: "shell.exec", args: { command: "test" } },
			{ type: "chunk", text: "after tool start" },
		];

		const { allIntents } = dispatchSequence(events);
		const postToolChunkIntents = allIntents[3]!;

		// The chunk intent is still emitted -- but by this point the reply block
		// has been reset, so this chunk creates a NEW markdown node with only
		// "after tool start" instead of appending to the accumulated text.
		expect(hasIntent(postToolChunkIntents, "reply-chunk"), "chunk still emits reply-chunk").toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 3. turn-complete correctly resets everything
// ---------------------------------------------------------------------------

describe("turn-complete cleanup", { tags: ["unit"] }, () => {
	it("turn-complete flushes typewriters and resets reply block", () => {
		const events: DispatchEvent[] = [
			{ type: "turn.start", timestamp: Date.now() },
			{ type: "chunk", text: "reply text" },
			{ type: "turn-complete" } as DispatchEvent,
		];

		const { finalIntents } = dispatchSequence(events);

		expect(hasIntent(finalIntents, "flush-reply-tw")).toBe(true);
		expect(hasIntent(finalIntents, "flush-thinking-tw")).toBe(true);
		expect(hasIntent(finalIntents, "reset-reply-block")).toBe(true);
		expect(hasIntent(finalIntents, "stop-thinking")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 4. tool lifecycle: start -> end produces correct intent pairs
// ---------------------------------------------------------------------------

describe("tool lifecycle intents", { tags: ["unit"] }, () => {
	it("tool-start adds show-in-flight-call, tool-end removes it", () => {
		const events: DispatchEvent[] = [
			{ type: "turn.start", timestamp: Date.now() },
			{
				type: "tool-start",
				callId: "c1",
				name: "shell.exec",
				args: { command: "npm test" },
			},
			{
				type: "tool-end",
				callId: "c1",
				elapsedMs: 100,
				ok: true,
			} as DispatchEvent,
		];

		const { allIntents } = dispatchSequence(events);

		const startIntents = allIntents[1]!;
		const endIntents = allIntents[2]!;

		expect(hasIntent(startIntents, "show-in-flight-call")).toBe(true);
		expect(hasIntent(endIntents, "remove-in-flight-call")).toBe(true);
	});

	it("active calls are tracked in state across tool lifecycle", () => {
		const events: DispatchEvent[] = [
			{ type: "turn.start", timestamp: Date.now() },
			{ type: "tool-start", callId: "c1", name: "shell.exec", args: { command: "test" } },
			{ type: "tool-start", callId: "c2", name: "fs.read", args: { path: "f.ts" } },
		];

		const { state } = dispatchSequence(events);

		expect(state.activeCalls.size).toBe(2);
		expect(state.activeCalls.has("c1")).toBe(true);
		expect(state.activeCalls.has("c2")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 5. scrollArchivedIntoHistory DEC 2026 wrapping
// ---------------------------------------------------------------------------

describe("archive write discipline", { tags: ["unit"] }, () => {
	it("scrollArchivedIntoHistory writes are not wrapped in DEC 2026 (BUG)", async () => {
		// This test documents the bug: scrollArchivedIntoHistory writes to the
		// terminal outside DEC 2026 synchronized output brackets, causing a
		// partial-frame flash when the terminal flushes between the archive
		// write and the main frame paint.

		const { Container, Text, TUI } = await import("@dpopsuev/alef-tui");
		const { VirtualTerminal } = await import("../../ui/tui/test/virtual-terminal.js");

		const terminal = new VirtualTerminal(60, 10);
		const writes: string[] = [];
		const origWrite = terminal.write.bind(terminal);
		terminal.write = (data: string) => {
			writes.push(data);
			origWrite(data);
		};

		const tui = new TUI(terminal);
		terminal.start(
			() => {},
			() => {},
		);
		tui.start();

		const chat = new Container();
		tui.addChild(chat);

		// A dock component to establish the dock boundary
		const dock = new Text("DOCK", 0, 0);
		tui.addChild(dock);
		tui.setDock(dock);

		// Initial render
		tui.requestRender(true);
		await new Promise<void>((r) => setTimeout(r, 50));
		writes.length = 0;

		// Add enough chat lines to trigger archiving
		for (let i = 0; i < 20; i++) {
			chat.addChild(new Text(`line-${i}`, 0, 0));
			tui.requestRender();
			await new Promise<void>((r) => setTimeout(r, 15));
		}

		// Find writes that contain scroll region setup (archive writes)
		const archiveWrites = writes.filter((w) => /\x1b\[1;\d+r/.test(w));

		// BUG: archive writes are separate from the frame paint write.
		// They should either be part of the same write buffer, or wrapped
		// in their own DEC 2026 brackets.
		if (archiveWrites.length > 0) {
			const firstArchive = archiveWrites[0]!;
			const hasDec2026Open = firstArchive.includes("\x1b[?2026h");
			// This documents the current state -- archive writes are NOT wrapped
			expect(
				hasDec2026Open,
				"archive writes should be wrapped in DEC 2026 brackets to prevent partial-frame flash",
			).toBe(false);
		}

		tui.stop();
	});
});
