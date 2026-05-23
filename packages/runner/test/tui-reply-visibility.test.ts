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
