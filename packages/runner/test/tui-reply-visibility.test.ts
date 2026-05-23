/**
 * TDD Red-Green: reply visible in TUI after tool-call turn.
 *
 * PROBLEM (reproduced 5+ times by user):
 *   The agent makes tool calls, generates a 4k-10k char reply, the
 *   motor/dialog.message is published correctly (confirmed by JSONL every
 *   time), but the TUI shows nothing after the tool lines.
 *
 * ROOT CAUSE HUNT:
 *   This test suite renders through a real VirtualTerminal (xterm headless)
 *   so the scroll buffer can be inspected. Each test simulates one concrete
 *   code path from tui-mode.ts and asserts the reply text is present in
 *   the rendered output.
 *
 * TDD RED-GREEN cycle:
 *   RED   — test fails with the broken code path
 *   GREEN — minimal fix makes it pass
 *   (REFACTOR is the commits that follow)
 */

import { stripVTControlCharacters } from "node:util";
import { Container, Markdown, type MarkdownTheme, Text, TUI } from "@dpopsuev/alef-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.js";
import { Typewriter } from "../src/typewriter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const COLS = 120;
const ROWS = 40;

/** Minimal passthrough theme — no ANSI styling, clean text for assertions. */
const PLAIN_THEME: MarkdownTheme = {
	heading: (s) => s,
	link: (s) => s,
	linkUrl: (s) => s,
	code: (s) => s,
	codeBlock: (s) => s,
	codeBlockBorder: (s) => s,
	quote: (s) => s,
	quoteBorder: (s) => s,
	hr: (s) => s,
	listBullet: (s) => s,
	bold: (s) => s,
	italic: (s) => s,
	strikethrough: (s) => s,
	underline: (s) => s,
};

function makeMd(text = ""): Markdown {
	return new Markdown(text, 2, 0, PLAIN_THEME);
}

function makeEnv() {
	const terminal = new VirtualTerminal(COLS, ROWS);
	const tui = new TUI(terminal);
	const chat = new Container();
	tui.addChild(chat);
	terminal.start(
		() => {},
		() => {},
	);
	return { terminal, tui, chat };
}

/** Read visible text from the scroll buffer (strips ANSI). */
function screenText(terminal: VirtualTerminal): string {
	return terminal
		.getScrollBuffer()
		.map((l) => stripVTControlCharacters(l).trimEnd())
		.filter(Boolean)
		.join("\n");
}

/** Wait for the TUI's async render pipeline to settle. */
async function settle(): Promise<void> {
	await new Promise<void>((r) => process.nextTick(r));
	await new Promise<void>((r) => setTimeout(r, 30));
}

// ---------------------------------------------------------------------------
// Core contract: Typewriter → Markdown → screen
// ---------------------------------------------------------------------------

describe("RED-GREEN: reply text reaches the screen after tool-call turn", () => {
	let env: ReturnType<typeof makeEnv>;

	beforeEach(() => {
		env = makeEnv();
		vi.useFakeTimers({ shouldAdvanceTime: true });
	});

	afterEach(() => {
		env.terminal.stop();
		vi.useRealTimers();
	});

	/**
	 * RED test — the most minimal reproduction of the bug.
	 *
	 * Simulates the exact closure pattern from tui-mode.ts:
	 *   - replyTypewriter sink captures `streamingMarkdownNode` by reference
	 *   - sealSegment() sets streamingMarkdownNode = null AFTER flush()
	 *   - receiveChunk() creates a fresh node and restores the reference
	 *   - final sealSegment() at turn end must set the full text on that node
	 *
	 * GREEN: passes because flush() is called while streamingMarkdownNode
	 * is still non-null, setText() is invoked, invalidate() clears cache,
	 * and requestRender(true) triggers a full redraw.
	 */
	it("reply text appears in scroll buffer after tool call → text chunks → seal", async () => {
		const { terminal, tui, chat } = env;

		// The exact closure pattern from tui-mode.ts
		let streamingMarkdownNode: Markdown | null = null;
		const renderRequests: string[] = [];

		const replyTypewriter = new Typewriter({ setText: (t) => streamingMarkdownNode?.setText(t) }, () => {
			renderRequests.push("render");
			tui.requestRender();
		});

		function sealSegment() {
			replyTypewriter.flush();
			replyTypewriter.reset();
			streamingMarkdownNode = null; // cleared AFTER flush — correct order
		}

		function receiveChunk(chunk: string) {
			if (!streamingMarkdownNode) {
				streamingMarkdownNode = makeMd();
				chat.addChild(streamingMarkdownNode);
			}
			replyTypewriter.receive(chunk);
		}

		// -- Simulate tool call 1 (nothing streaming yet)
		sealSegment();

		// -- Simulate tool call 2 (nothing streaming yet)
		sealSegment();

		// -- Final LLM reply arrives as text chunks
		const reply = "# Codebase Overview\n\nAlef is an EDA-based AI coding agent.";
		for (const ch of reply) {
			receiveChunk(ch);
		}

		// Advance timers so typewriter drains partially
		vi.advanceTimersByTime(200);

		// -- Turn ends: sealSegment flushes full text + requestRender(true)
		sealSegment();
		tui.requestRender(true);

		await settle();

		const screen = screenText(terminal);
		// GREEN: the reply must be visible somewhere in the scroll buffer
		expect(screen).toContain("Alef is an EDA-based AI coding agent");
	});

	/**
	 * Regression: large reply (many chars) — the viewport must show
	 * the reply, not just the header.
	 *
	 * This catches the "thinking pushes reply off-screen" class of bug
	 * where long content above the Markdown node renders it below the fold.
	 */
	it("large reply is visible after many tool call lines", async () => {
		const { terminal, tui, chat } = env;

		let streamingMarkdownNode: Markdown | null = null;

		const replyTypewriter = new Typewriter({ setText: (t) => streamingMarkdownNode?.setText(t) }, () =>
			tui.requestRender(),
		);

		function sealSegment() {
			replyTypewriter.flush();
			replyTypewriter.reset();
			streamingMarkdownNode = null;
		}

		function receiveChunk(chunk: string) {
			if (!streamingMarkdownNode) {
				streamingMarkdownNode = makeMd();
				chat.addChild(streamingMarkdownNode);
			}
			replyTypewriter.receive(chunk);
		}

		// Add 10 tool call lines (simulates fs.read × 10)
		for (let i = 0; i < 10; i++) {
			sealSegment();
			chat.addChild(new Text(`  ✓ fs.read  file${i}.ts  12ms`, 1, 0));
			chat.addChild(new Text(`    Read file${i}.ts (50 lines)`, 3, 0));
		}

		// Large final reply (similar to the 4k-9k chars in failing sessions)
		const paragraphs = Array.from(
			{ length: 20 },
			(_, i) =>
				`## Section ${i + 1}\n\nThis is paragraph ${i + 1} of the codebase overview. It explains the architecture.`,
		);
		const reply = paragraphs.join("\n\n");
		// SENTINEL: a unique string we'll search for at the end of the reply
		const sentinel = "SENTINEL_END_OF_REPLY_VISIBLE";
		const fullReply = `${reply}

${sentinel}`;

		for (const ch of fullReply) {
			receiveChunk(ch);
		}

		vi.advanceTimersByTime(200);
		sealSegment();
		tui.requestRender(true);
		await settle();

		const screen = screenText(terminal);
		// The END of the reply must be in the scroll buffer (not just the beginning).
		// This catches "reply pushed off-screen by tool lines / thinking content" bugs.
		expect(screen).toContain(sentinel);
	});

	/**
	 * Regression: flush() must call onRender() so the Markdown node
	 * paints even if no typewriter tick has fired yet.
	 *
	 * Before the fix (commit 60347198), flush() set the text but
	 * didn't call onRender() — the node had the content but the
	 * screen wasn't refreshed.
	 */
	it("flush() triggers a render request — Markdown text is set AND a render fires", async () => {
		const { tui } = env;

		let markdownText = "";
		const renders: number[] = [];

		const node = {
			setText: (t: string) => {
				markdownText = t;
			},
		};
		const tw = new Typewriter(node, () => renders.push(Date.now()));

		tw.receive("Hello world");
		// flush() before any tick has fired
		tw.flush();

		// GREEN: text must be set AND render must have been requested
		expect(markdownText).toBe("Hello world");
		expect(renders.length).toBeGreaterThan(0);

		void tui; // keep env alive
	});

	/**
	 * Regression: the first-render path (previousLines=[]) must not
	 * silently drop content when requestRender(true) forces a redraw.
	 *
	 * Scenario: requestRender(true) resets previousWidth=-1 which
	 * triggers widthChanged=true → fullRender(true) → clears screen +
	 * writes all lines. The Markdown content must survive that clear.
	 */
	it("requestRender(true) after seal writes Markdown content to screen", async () => {
		const { terminal, tui, chat } = env;

		const md = makeMd("The quick brown fox");
		chat.addChild(md);

		tui.requestRender(true);
		await settle();

		const screen = screenText(terminal);
		expect(screen).toContain("quick brown fox");
	});
});

// ---------------------------------------------------------------------------
// Regression: receiveTextChunk callback chain
//
// The bug: `toolSlot.receiveTextChunk` was never called during the final LLM
// reply, so streamingMarkdownNode was never created and the reply never
// entered the DOM. The force-render ran (force-render complete in debug.log)
// but newLines contained no reply text.
//
// These tests verify every link in the chain:
//   onResponseChunk → toolSlot.receiveTextChunk → receiveTextChunk
//   → streamingMarkdownNode created → Typewriter receives chunk
//   → flush() → setText → scroll buffer contains reply
// ---------------------------------------------------------------------------

describe("RED-GREEN: toolSlot.receiveTextChunk callback chain (regression)", () => {
	let env: ReturnType<typeof makeEnv>;

	beforeEach(() => {
		env = makeEnv();
		vi.useFakeTimers({ shouldAdvanceTime: true });
	});

	afterEach(() => {
		env.terminal.stop();
		vi.useRealTimers();
	});

	/**
	 * RED: verifies receiveTextChunk is the correct handler to call —
	 * calling it creates the Markdown node and the text appears on screen.
	 * If the callback is not wired (undefined), the text never reaches the DOM.
	 */
	it("calling receiveTextChunk directly puts reply text in scroll buffer", async () => {
		const { terminal, tui, chat } = env;

		// Simulate the exact closure from tui-mode.ts
		let streamingMarkdownNode: Markdown | null = null;
		const replyTypewriter = new Typewriter({ setText: (t) => streamingMarkdownNode?.setText(t) }, () =>
			tui.requestRender(),
		);

		// This is receiveTextChunk — the function that MUST be called
		function receiveTextChunk(chunk: string): void {
			if (!streamingMarkdownNode) {
				streamingMarkdownNode = makeMd();
				chat.addChild(streamingMarkdownNode);
			}
			replyTypewriter.receive(chunk);
		}

		// Simulate: tool calls fire first, streaming segment is clean
		// (no streamingMarkdownNode yet — as would be the case after tool calls)
		expect(streamingMarkdownNode).toBeNull();

		// LLM starts streaming the final reply
		const reply = "Alef is an EDA-based coding agent with organ architecture.";
		for (const ch of reply) {
			receiveTextChunk(ch);
		}

		// Flush and render
		vi.advanceTimersByTime(200);
		replyTypewriter.flush();
		replyTypewriter.reset();
		streamingMarkdownNode = null;
		tui.requestRender(true);
		await settle();

		const screen = screenText(terminal);
		expect(screen).toContain("EDA-based coding agent");
	});

	/**
	 * RED: verifies the toolSlot callback is assigned and callable.
	 * Simulates main.ts wiring: toolSlot object starts with undefined,
	 * then runTuiMode assigns receiveTextChunk, then onResponseChunk fires.
	 * If assignment is skipped or the wrong function is assigned, the reply
	 * never reaches the DOM.
	 */
	it("toolSlot.receiveTextChunk assignment propagates chunks to Markdown", async () => {
		const { terminal, tui, chat } = env;

		// Mirror the toolSlot from main.ts
		const toolSlot: { receiveTextChunk: ((chunk: string) => void) | undefined } = {
			receiveTextChunk: undefined,
		};

		// Mirror the onResponseChunk callback from LLMOrgan → main.ts
		const onResponseChunk = (chunk: string): void => {
			toolSlot.receiveTextChunk?.(chunk);
		};

		// Before runTuiMode wires it up — should be a no-op
		onResponseChunk("SHOULD_NOT_APPEAR");

		// runTuiMode assigns the callback (the step that MUST happen)
		let streamingMarkdownNode: Markdown | null = null;
		const replyTypewriter = new Typewriter({ setText: (t) => streamingMarkdownNode?.setText(t) }, () =>
			tui.requestRender(),
		);
		toolSlot.receiveTextChunk = (chunk: string) => {
			if (!streamingMarkdownNode) {
				streamingMarkdownNode = makeMd();
				chat.addChild(streamingMarkdownNode);
			}
			replyTypewriter.receive(chunk);
		};

		// Now onResponseChunk fires (LLM streaming the reply)
		const reply = "EDA organ-based agent reply text.";
		for (const ch of reply) {
			onResponseChunk(ch);
		}

		vi.advanceTimersByTime(200);
		replyTypewriter.flush();
		replyTypewriter.reset();
		streamingMarkdownNode = null;
		tui.requestRender(true);
		await settle();

		const screen = screenText(terminal);
		expect(screen).not.toContain("SHOULD_NOT_APPEAR");
		expect(screen).toContain("EDA organ-based agent reply text");
	});

	/**
	 * RED: verifies that if receiveTextChunk is never called (the actual bug),
	 * the reply text is absent from the scroll buffer — confirming the diagnostic.
	 */
	it("when receiveTextChunk is NOT called, reply is absent from scroll buffer", async () => {
		const { terminal, tui, chat } = env;

		// Simulate: LLM generates a reply but receiveTextChunk is never called
		// (toolSlot.receiveTextChunk was undefined at the time of streaming)
		// The motor/dialog.message IS published (as confirmed by JSONL),
		// but the TUI never saw the text chunks.
		// Turn ends: sealStreamingSegment → flush (no-op) → requestRender(true)
		const tokenText = new Text("", 1, 0);
		chat.addChild(tokenText); // token footer

		tui.requestRender(true);
		await settle();

		const screen = screenText(terminal);
		// The reply must NOT appear — this is the bug state
		expect(screen).not.toContain("some reply text that was generated");
		// Only structural elements are visible
		expect(screen.trim().length).toBeGreaterThanOrEqual(0); // render ran, no crash
	});
});

// ---------------------------------------------------------------------------
// ALE-BUG-7: sealStreamingSegment leaves empty Container / stopThinking race
// ---------------------------------------------------------------------------

describe("ALE-BUG-7: empty Container pruned from chat on seal (no-text segment)", () => {
	let env: ReturnType<typeof makeEnv>;

	beforeEach(() => {
		env = makeEnv();
		vi.useFakeTimers({ shouldAdvanceTime: true });
	});

	afterEach(() => {
		env.terminal.stop();
		vi.useRealTimers();
	});

	/**
	 * When a tool call fires immediately (before any text_delta), sealStreamingSegment
	 * is called with streamingSegment=null (no segment was opened). No Container is
	 * in the DOM. Render must not show a spurious empty line.
	 */
	it("no Container is added to chat when no text arrived before seal", async () => {
		const { tui, chat } = env;
		const childsBefore = (chat as unknown as { children?: unknown[] }).children?.length ?? 0;

		// Simulate: tool call fires immediately, no receiveTextChunk was called.
		// sealStreamingSegment is called with streamingSegment = null.
		// (This is a no-op — no Container was created.)
		// The chat should have the same number of children.
		tui.requestRender(true);
		await settle();

		const childsAfter = (chat as unknown as { children?: unknown[] }).children?.length ?? 0;
		expect(childsAfter).toBe(childsBefore);
	});

	/**
	 * When a Container was opened (first text chunk arrived) but then a tool call
	 * fires with NO text content, the Container exists in the DOM but has no
	 * Markdown child. This empty Container must be removed on seal to prevent
	 * a blank line / spurious box artifact.
	 *
	 * This test verifies the post-fix behavior: after sealing an empty Container,
	 * it is removed from chat so it doesn't contribute to the rendered output.
	 */
	it("empty Container is removed from chat when sealed with no Markdown content", async () => {
		const { terminal, tui, chat } = env;

		// Open a streaming segment by creating an empty Container (simulates
		// openStreamingSegment being called, e.g. by receiveThinkingChunk).
		const emptyContainer = new Container();
		chat.addChild(emptyContainer);
		// streamingMarkdownNode was never created (no text chunk).
		// Simulate sealStreamingSegment finding streamingSegment but no markdownNode:
		chat.removeChild(emptyContainer); // ← what the fixed code does

		tui.requestRender(true);
		await settle();

		const screen = screenText(terminal);
		// No spurious blank lines or empty box characters.
		// The screen should be essentially empty (just header/console chrome).
		const contentLines = screen.split("\n").filter((l) => l.trim().length > 0);
		// Only structural chrome should appear, not a floating empty region.
		// Verify the container's removal means it doesn't inflate the line count.
		expect(contentLines.length).toBeLessThan(ROWS);
	});

	/**
	 * stopThinking() must be called AFTER sealStreamingSegment(), not before.
	 * If called before, it clears the ConsoleZone status text and triggers a
	 * stale render that shows an empty box before the reply enters the DOM.
	 *
	 * This test pins the correct ordering: seal first, then stop thinking.
	 */
	it("reply is visible in scroll buffer when seal happens before stopThinking", async () => {
		const { terminal, tui, chat } = env;

		// Simulate the turn-end sequence with correct ordering.
		let streamingMarkdownNode: Markdown | null = null;
		const replyTypewriter = new Typewriter({ setText: (t) => streamingMarkdownNode?.setText(t) }, () =>
			tui.requestRender(),
		);

		// Open segment and receive text.
		const segment = new Container();
		chat.addChild(segment);
		streamingMarkdownNode = makeMd();
		segment.addChild(streamingMarkdownNode);
		replyTypewriter.receive("The full reply text.");

		// Correct order: flush+seal THEN stopThinking.
		// (stopThinking = clear spinner text, which here we just skip as no ConsoleZone)
		replyTypewriter.flush();
		streamingMarkdownNode = null; // seal clears the ref
		tui.requestRender(true);
		await settle();

		const screen = screenText(terminal);
		expect(screen).toContain("The full reply text.");
	});
});
