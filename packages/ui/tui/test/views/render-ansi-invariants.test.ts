/**
 * ANSI byte-stream invariant tests
 *
 * These tests inspect the raw ANSI bytes emitted to the terminal's write()
 * method, not the rendered output. VirtualTerminal hides mid-frame artifacts;
 * CapturingTerminal makes them visible.
 *
 * RC-1: cursor must be hidden before any cursor-up movement within a frame.
 * RC-2: differential renders must not emit \x1b[2J (clear screen = blank frame).
 * DEC 2026: every frame must be synchronized-output bracketed.
 *
 * Tests marked RED by design document known gaps; they become GREEN when
 * the corresponding tuning item (T-1, T-3) is implemented.
 */

import { describe, expect, it } from "vitest";
import { Text } from "../../src/components/text.js";
import { Container, TUI } from "../../src/tui.js";
import { DynamicText } from "../../src/views/index.js";
import { CapturingTerminal } from "../capturing-terminal.js";

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

function makeEnv(cols = 80, rows = 24) {
	const terminal = new CapturingTerminal(cols, rows);
	const tui = new TUI(terminal);
	const chat = new Container();
	tui.addChild(chat);
	terminal.start(
		() => {},
		() => {},
	);
	tui.start();
	return { terminal, tui, chat };
}

async function settle(ms = 30): Promise<void> {
	await new Promise<void>((r) => process.nextTick(r));
	await new Promise<void>((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// DEC 2026 — synchronized output bracketing
// ---------------------------------------------------------------------------

describe("DEC 2026 — every render frame is sync-bracketed", { tags: ["unit"] }, () => {
	it("initial fullRender is wrapped in \\x1b[?2026h...\\x1b[?2026l", async () => {
		const { terminal, tui, chat } = makeEnv();
		chat.addChild(new Text("hello", 0, 0));
		tui.requestRender(true);
		await settle();

		const frames = terminal.getFrames();
		expect(frames.length).toBeGreaterThan(0);
		for (const f of frames) {
			expect(f.syncEnd).toBe(true);
		}
		tui.stop();
	});

	it("differential render is wrapped in \\x1b[?2026h...\\x1b[?2026l", async () => {
		const { terminal, tui, chat } = makeEnv();
		const node = new Text("v1", 0, 0);
		chat.addChild(node);
		tui.requestRender(true);
		await settle();
		terminal.clearLog();

		node.setText("v2");
		tui.requestRender();
		await settle();

		const frames = terminal.getFrames();
		expect(frames.length).toBeGreaterThan(0);
		for (const f of frames) {
			expect(f.syncEnd).toBe(true);
		}
		tui.stop();
	});
});

// ---------------------------------------------------------------------------
// RC-1 — cursor hide/show around cursor-up movement
// ---------------------------------------------------------------------------

describe.todo("RC-1 — cursor hidden before cursor-up movement (T-1 not yet implemented)", () => {
	it("differential render: \\x1b[?25l precedes first \\x1b[nA in frame", async () => {
		const { terminal, tui, chat } = makeEnv(80, 10);

		// Add enough content for a differential render with cursor movement.
		for (let i = 0; i < 5; i++) chat.addChild(new Text(`line ${i}`, 0, 0));
		tui.requestRender(true);
		await settle();
		terminal.clearLog();

		// Change the first line — forces cursor-up to rewrite it.
		(chat.children[0] as Text).setText("changed");
		tui.requestRender();
		await settle();

		const frames = terminal.getFrames();
		const movingFrames = frames.filter((f) => f.hasCursorUp);

		// GREEN when T-1 (cursor hide/show) is implemented.
		// Until then, this documents the gap: cursor is visible during movement.
		for (const f of movingFrames) {
			expect(f.cursorHideBeforeFirstMove).toBe(true); // RED: T-1 not yet done
		}
		tui.stop();
	});
});

// ---------------------------------------------------------------------------
// RC-2 — no clear screen in differential or DockConsole renders
// ---------------------------------------------------------------------------

describe("RC-2 — no \\x1b[2J in differential renders", { tags: ["unit"] }, () => {
	it("content change within viewport does not emit clear screen", async () => {
		const { terminal, tui, chat } = makeEnv(80, 24);

		for (let i = 0; i < 5; i++) chat.addChild(new Text(`line ${i}`, 0, 0));
		tui.requestRender(true);
		await settle();
		terminal.clearLog();

		// Change a line that is within the viewport.
		(chat.children[4] as Text).setText("changed within viewport");
		tui.requestRender();
		await settle();

		const frames = terminal.getFrames();
		const clearFrames = frames.filter((f) => f.hasClearScreen);
		expect(clearFrames.length).toBe(0);
		tui.stop();
	});

	it("DockConsole-style DynamicText (always in viewport) never emits clear screen", async () => {
		// Content fills 8 lines, viewport is 10. DynamicText at bottom — always in viewport.
		const { terminal, tui, chat } = makeEnv(40, 10);

		for (let i = 0; i < 8; i++) chat.addChild(new Text(`line ${i}`, 0, 0));

		let tick = 0;
		const liveBottom = new DynamicText(() => `status: ${tick}`);
		tui.addChild(liveBottom);

		tui.requestRender(true);
		await settle();
		terminal.clearLog();

		for (let i = 0; i < 5; i++) {
			tick++;
			tui.requestRender();
			await settle(20);
		}

		const frames = terminal.getFrames();
		const clearFrames = frames.filter((f) => f.hasClearScreen);
		expect(clearFrames.length).toBe(0);
		tui.stop();
	});

	it("above-viewport DynamicText no longer emits clear screen after T-3 fix", async () => {
		// DynamicText at index 0, pushed above viewport by 8 more lines.
		const { terminal, tui, chat } = makeEnv(40, 5);

		let tick = 0;
		const live = new DynamicText(() => `live: ${tick}`);
		chat.addChild(live);
		for (let i = 0; i < 8; i++) chat.addChild(new Text(`line ${i}`, 0, 0));

		tui.requestRender(true);
		await settle();
		terminal.clearLog();

		tick = 1;
		tui.requestRender();
		await settle();

		const frames = terminal.getFrames();
		const clearFrames = frames.filter((f) => f.hasClearScreen);
		// T-3 fix: above-viewport changes no longer trigger fullRender(clear=true).
		// The stale line stays in scrollback; the visible viewport renders cleanly.
		expect(clearFrames.length).toBe(0);
		tui.stop();
	});
});

// ---------------------------------------------------------------------------
// RC-8 — single write() syscall per render frame
// ---------------------------------------------------------------------------

describe("RC-8 — one write() call per render frame", { tags: ["unit"] }, () => {
	it("fullRender produces exactly 1 write() call", async () => {
		const { terminal, tui, chat } = makeEnv();
		chat.addChild(new Text("hello", 0, 0));
		terminal.clearLog();

		tui.requestRender(true);
		await settle();

		// One render = one terminal.write() call = one PTY write() syscall.
		// Multiple calls would let the terminal render intermediate states.
		expect(terminal.getWriteCount()).toBe(1);
		tui.stop();
	});

	it("differential render produces exactly 1 write() call", async () => {
		const { terminal, tui, chat } = makeEnv();
		const node = new Text("v1", 0, 0);
		chat.addChild(node);
		tui.requestRender(true);
		await settle();
		terminal.clearLog();

		node.setText("v2");
		tui.requestRender();
		await settle();

		expect(terminal.getWriteCount()).toBe(1);
		tui.stop();
	});

	it("1000 rapid requestRender() calls still produce exactly 1 write() per frame", async () => {
		const { terminal, tui, chat } = makeEnv();
		chat.addChild(new Text("content", 0, 0));
		tui.requestRender(true);
		await settle();
		terminal.clearLog();

		for (let i = 0; i < 1000; i++) tui.requestRender();
		await settle(50);

		// Coalescing ensures at most a few renders. Each render = 1 write().
		// Total writes == total renders, never writes > renders.
		const frames = terminal.getFrames();
		expect(terminal.getWriteCount()).toBe(frames.length);
		tui.stop();
	});
});
