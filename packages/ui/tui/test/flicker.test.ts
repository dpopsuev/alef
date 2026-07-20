/**
 * Flicker regression tests.
 *
 * These tests detect the root causes of terminal flicker:
 *   RC-1: Erase-line on unchanged rows
 *   RC-2: Full viewport clear during incremental updates
 *   RC-3: Missing DEC 2026 synchronized output brackets
 *   RC-4: Cursor visible during movement
 *   RC-5: Disproportionate byte volume
 *
 * Every assertion uses the flicker harness, which embeds render path,
 * erased rows, absolute positions, byte counts, and raw ANSI in the
 * failure message so the developer can locate the issue immediately.
 *
 * Verified: 7 of 21 tests FAIL when the old dock-full path is restored.
 */

import { describe, it } from "vitest";
import { Text } from "../src/components/text.js";
import { Container } from "../src/tui.js";
import { DynamicText } from "../src/views/index.js";
import { createFlickerEnv } from "./flicker-harness.js";

// ---------------------------------------------------------------------------
// RC-1: Erase-line on unchanged rows
// ---------------------------------------------------------------------------

describe("RC-1: erase-line count matches changed lines", { tags: ["unit"] }, () => {
	it("single dock line change erases exactly 1 line", async () => {
		const env = createFlickerEnv(40, 8);
		const chat = new Container();
		env.tui.addChild(chat);
		for (let i = 0; i < 20; i++) chat.addChild(new Text(`msg-${i}`, 0, 0));

		let tick = 0;
		const dock = new DynamicText(() => `status:${tick}`);
		env.tui.addChild(dock);
		env.tui.setDock(dock);

		env.tui.requestRender(true);
		await env.settle();
		env.clearLog();

		tick = 1;
		env.tui.requestRender();
		await env.settle();

		env.assertEraseLines(1, "single dock tick");
		env.tui.stop();
	});

	it("spinner animation never erases more than 1 line per frame", async () => {
		const env = createFlickerEnv(40, 10);
		const chat = new Container();
		env.tui.addChild(chat);
		for (let i = 0; i < 30; i++) chat.addChild(new Text(`line-${i}`, 0, 0));

		let frame = "|";
		const dock = new DynamicText(() => `working ${frame}`);
		env.tui.addChild(dock);
		env.tui.setDock(dock);

		env.tui.requestRender(true);
		await env.settle();

		const spinnerFrames = ["/", "-", "\\", "|", "/", "-", "\\", "|"];
		for (const sf of spinnerFrames) {
			env.clearLog();
			frame = sf;
			env.tui.requestRender();
			await env.settle(20);

			env.assertMaxEraseLinesPerFrame(1, `spinner '${sf}'`);
		}
		env.tui.stop();
	});

	it("multi-line dock change erases only changed lines", async () => {
		const env = createFlickerEnv(40, 10);
		const chat = new Container();
		env.tui.addChild(chat);
		for (let i = 0; i < 20; i++) chat.addChild(new Text(`msg-${i}`, 0, 0));

		let tick = 0;
		const line1 = new DynamicText(() => `status:${tick}`);
		const line2 = new DynamicText(() => `progress:${tick}`);
		const line3 = new Text("static-footer", 0, 0);
		const dockContainer = new Container();
		dockContainer.addChild(line1);
		dockContainer.addChild(line2);
		dockContainer.addChild(line3);
		env.tui.addChild(dockContainer);
		env.tui.setDock(dockContainer);

		env.tui.requestRender(true);
		await env.settle();
		env.clearLog();

		tick = 1;
		env.tui.requestRender();
		await env.settle();

		env.assertEraseLines(2, "2 dynamic + 1 static dock lines");
		env.tui.stop();
	});

	it("chat body changes do not erase stable dock lines", async () => {
		const env = createFlickerEnv(40, 6);
		const chat = new Container();
		env.tui.addChild(chat);
		for (let i = 0; i < 10; i++) chat.addChild(new Text(`msg-${i}`, 0, 0));

		const dock = new Text("FOOTER", 0, 0);
		env.tui.addChild(dock);
		env.tui.setDock(dock);

		env.tui.requestRender(true);
		await env.settle();
		env.clearLog();

		chat.addChild(new Text("msg-10", 0, 0));
		env.tui.requestRender();
		await env.settle();

		if (env.tui.renderMeta.renderPath === "diff") {
			env.assertContentNotRewritten("FOOTER", "stable dock after chat scroll");
		}
		env.tui.stop();
	});
});

// ---------------------------------------------------------------------------
// RC-2: Full viewport clear during incremental updates
// ---------------------------------------------------------------------------

describe("RC-2: no clear-screen during incremental updates", { tags: ["unit"] }, () => {
	it("dock-only updates never clear screen", async () => {
		const env = createFlickerEnv(40, 8);
		const chat = new Container();
		env.tui.addChild(chat);
		for (let i = 0; i < 20; i++) chat.addChild(new Text(`msg-${i}`, 0, 0));

		let tick = 0;
		const dock = new DynamicText(() => `tick:${tick}`);
		env.tui.addChild(dock);
		env.tui.setDock(dock);

		env.tui.requestRender(true);
		await env.settle();
		env.clearLog();

		for (let i = 1; i <= 10; i++) {
			tick = i;
			env.tui.requestRender();
			await env.settle(20);
		}

		env.assertNoClearScreen("dock ticks");
		env.tui.stop();
	});

	it("non-dock content append never clears screen", async () => {
		const env = createFlickerEnv(40, 10);
		const chat = new Container();
		env.tui.addChild(chat);
		chat.addChild(new Text("seed", 0, 0));

		env.tui.requestRender(true);
		await env.settle();
		env.clearLog();

		for (let i = 0; i < 5; i++) {
			chat.addChild(new Text(`line-${i}`, 0, 0));
			env.tui.requestRender();
			await env.settle(20);
		}

		env.assertNoClearScreen("content append");
		env.tui.stop();
	});

	it("dock-reflow does not clear screen (only repaints viewport)", async () => {
		const env = createFlickerEnv(40, 8);
		const chat = new Container();
		env.tui.addChild(chat);
		for (let i = 0; i < 20; i++) chat.addChild(new Text(`msg-${i}`, 0, 0));

		const dockContainer = new Container();
		dockContainer.addChild(new Text("dock-1", 0, 0));
		env.tui.addChild(dockContainer);
		env.tui.setDock(dockContainer);

		env.tui.requestRender(true);
		await env.settle();
		env.clearLog();

		dockContainer.addChild(new Text("dock-2", 0, 0));
		env.tui.requestRender();
		await env.settle();

		env.assertRenderPath("dock-reflow", "dock height grew");
		env.assertNoClearScreen("dock reflow");
		env.tui.stop();
	});
});

// ---------------------------------------------------------------------------
// RC-3: DEC 2026 synchronized output
// ---------------------------------------------------------------------------

describe("RC-3: synchronized output brackets", { tags: ["unit"] }, () => {
	it("every dock diff frame has sync brackets", async () => {
		const env = createFlickerEnv(40, 8);
		const chat = new Container();
		env.tui.addChild(chat);
		for (let i = 0; i < 20; i++) chat.addChild(new Text(`msg-${i}`, 0, 0));

		let tick = 0;
		const dock = new DynamicText(() => `dock:${tick}`);
		env.tui.addChild(dock);
		env.tui.setDock(dock);

		env.tui.requestRender(true);
		await env.settle();
		env.clearLog();

		for (let i = 1; i <= 5; i++) {
			tick = i;
			env.tui.requestRender();
			await env.settle(20);
		}

		env.assertSyncBrackets("dock diffs");
		env.tui.stop();
	});

	it("every non-dock diff frame has sync brackets", async () => {
		const env = createFlickerEnv(40, 10);
		const chat = new Container();
		env.tui.addChild(chat);
		chat.addChild(new Text("header", 0, 0));
		chat.addChild(new Text("body", 0, 0));

		env.tui.requestRender(true);
		await env.settle();
		env.clearLog();

		chat.addChild(new Text("new-line", 0, 0));
		env.tui.requestRender();
		await env.settle();

		env.assertSyncBrackets("non-dock append");
		env.tui.stop();
	});

	it("full redraws also have sync brackets", async () => {
		const env = createFlickerEnv(40, 8);
		const chat = new Container();
		env.tui.addChild(chat);
		chat.addChild(new Text("hello", 0, 0));

		env.tui.requestRender(true);
		await env.settle();

		env.assertSyncBrackets("initial render");
		env.tui.stop();
	});
});

// ---------------------------------------------------------------------------
// RC-4: Cursor visible during movement
// ---------------------------------------------------------------------------

describe("RC-4: cursor hidden during movement", { tags: ["unit"] }, () => {
	it("dock diff frames hide cursor before positioning", async () => {
		const env = createFlickerEnv(40, 8);
		const chat = new Container();
		env.tui.addChild(chat);
		for (let i = 0; i < 20; i++) chat.addChild(new Text(`msg-${i}`, 0, 0));

		let tick = 0;
		const dock = new DynamicText(() => `dock:${tick}`);
		env.tui.addChild(dock);
		env.tui.setDock(dock);

		env.tui.requestRender(true);
		await env.settle();
		env.clearLog();

		tick = 1;
		env.tui.requestRender();
		await env.settle();

		env.assertCursorHidden("dock diff");
		env.tui.stop();
	});

	it("full redraws hide cursor before any movement", async () => {
		const env = createFlickerEnv(40, 8);
		const chat = new Container();
		env.tui.addChild(chat);
		chat.addChild(new Text("hello", 0, 0));

		const dock = new Text("dock", 0, 0);
		env.tui.addChild(dock);
		env.tui.setDock(dock);

		env.tui.requestRender(true);
		await env.settle();

		env.assertCursorHidden("full redraw");
		env.tui.stop();
	});
});

// ---------------------------------------------------------------------------
// RC-5: Byte volume proportionality
// ---------------------------------------------------------------------------

describe("RC-5: diff frame byte volume", { tags: ["unit"] }, () => {
	it("dock-only diff is smaller than full frame", async () => {
		const env = createFlickerEnv(60, 20);
		const chat = new Container();
		env.tui.addChild(chat);
		for (let i = 0; i < 40; i++) chat.addChild(new Text(`chat-line-${i}-padding`, 0, 0));

		let tick = 0;
		const dock = new DynamicText(() => `dock:${tick}`);
		env.tui.addChild(dock);
		env.tui.setDock(dock);

		env.tui.requestRender(true);
		await env.settle();
		const fullBytes = env.byteCount();

		env.clearLog();
		tick = 1;
		env.tui.requestRender();
		await env.settle();

		env.assertBytesBelow(Math.floor(fullBytes / 2), "diff vs full");
		env.tui.stop();
	});

	it("diff byte volume scales with changed lines, not viewport size", async () => {
		const env = createFlickerEnv(60, 20);
		const chat = new Container();
		env.tui.addChild(chat);
		for (let i = 0; i < 40; i++) chat.addChild(new Text(`chat-line-${i}-padding`, 0, 0));

		let tick = 0;
		const dock = new DynamicText(() => `dock:${tick}`);
		env.tui.addChild(dock);
		env.tui.setDock(dock);

		env.tui.requestRender(true);
		await env.settle();

		const diffSizes: number[] = [];
		for (let i = 1; i <= 5; i++) {
			env.clearLog();
			tick = i;
			env.tui.requestRender();
			await env.settle(20);
			diffSizes.push(env.byteCount());
		}

		const avg = diffSizes.reduce((a, b) => a + b, 0) / diffSizes.length;
		for (let i = 0; i < diffSizes.length; i++) {
			const deviation = Math.abs(diffSizes[i]! - avg);
			if (deviation >= avg * 0.5) {
				const diag = env.analyzed().map((a, fi) => {
					const meta = a.renderMeta;
					return `  frame ${fi}: ${a.byteCount}b, path=${meta?.renderPath ?? "?"}, erases=${a.eraseLineCount}`;
				}).join("\n");
				throw new Error(
					`frame ${i} byte count ${diffSizes[i]} deviates >50% from avg ${avg.toFixed(0)}\n${diag}`,
				);
			}
		}
		env.tui.stop();
	});
});

// ---------------------------------------------------------------------------
// Integrated scenario: streaming token simulation
// ---------------------------------------------------------------------------

describe("streaming simulation", { tags: ["unit"] }, () => {
	it("token-by-token streaming with stable dock produces no flicker", async () => {
		const env = createFlickerEnv(60, 15);
		const chat = new Container();
		env.tui.addChild(chat);

		const dock = new Text("waiting for input...", 0, 0);
		env.tui.addChild(dock);
		env.tui.setDock(dock);

		env.tui.requestRender(true);
		await env.settle();
		env.clearLog();

		const tokens = "The quick brown fox jumps over the lazy dog".split(" ");
		let accumulated = "";
		const streamLine = new Text("", 0, 0);
		chat.addChild(streamLine);
		for (const token of tokens) {
			accumulated += (accumulated ? " " : "") + token;
			streamLine.setText(accumulated);
			env.tui.requestRender();
			await env.settle(20);
		}

		env.assertNoClearScreen("streaming");
		env.assertSyncBrackets("streaming");
		env.assertContentNotRewritten("waiting for input...", "dock stable during stream");
		env.tui.stop();
	});

	it("concurrent streaming + spinner produces clean frames", async () => {
		const env = createFlickerEnv(60, 12);
		const chat = new Container();
		env.tui.addChild(chat);

		let spinnerIdx = 0;
		const spinnerChars = ["|", "/", "-", "\\"];
		const dock = new DynamicText(() => `thinking ${spinnerChars[spinnerIdx % 4]}`);
		env.tui.addChild(dock);
		env.tui.setDock(dock);

		env.tui.requestRender(true);
		await env.settle();
		env.clearLog();

		const streamLine = new Text("", 0, 0);
		chat.addChild(streamLine);
		let text = "";
		for (let i = 0; i < 10; i++) {
			text += `word${i} `;
			streamLine.setText(text);
			spinnerIdx = i;
			env.tui.requestRender();
			await env.settle(20);
		}

		env.assertSyncBrackets("streaming + spinner");
		env.assertNoClearScreen("streaming + spinner");
		env.tui.stop();
	});
});

// ---------------------------------------------------------------------------
// No-change optimization
// ---------------------------------------------------------------------------

describe("no-change optimization", { tags: ["unit"] }, () => {
	it("identical re-render produces zero erase-lines", async () => {
		const env = createFlickerEnv(40, 8);
		const chat = new Container();
		env.tui.addChild(chat);
		chat.addChild(new Text("hello", 0, 0));

		const dock = new Text("footer", 0, 0);
		env.tui.addChild(dock);
		env.tui.setDock(dock);

		env.tui.requestRender(true);
		await env.settle();
		env.clearLog();

		env.tui.requestRender();
		await env.settle();

		env.assertEraseLines(0, "no-change re-render");
		env.assertRenderPath("no-change", "identical content");
		env.tui.stop();
	});

	it("multiple identical re-renders emit nothing", async () => {
		const env = createFlickerEnv(40, 8);
		const chat = new Container();
		env.tui.addChild(chat);
		for (let i = 0; i < 10; i++) chat.addChild(new Text(`msg-${i}`, 0, 0));

		const dock = new Text("dock", 0, 0);
		env.tui.addChild(dock);
		env.tui.setDock(dock);

		env.tui.requestRender(true);
		await env.settle();
		env.clearLog();

		for (let i = 0; i < 5; i++) {
			env.tui.requestRender();
			await env.settle(20);
		}

		env.assertEraseLines(0, "5 identical re-renders");
		env.tui.stop();
	});
});

// ---------------------------------------------------------------------------
// Harness self-test
// ---------------------------------------------------------------------------

describe("flicker harness: analyzeFlickerFrame", { tags: ["unit"] }, () => {
	it("detects erase-line sequences", async () => {
		const env = createFlickerEnv(40, 5);
		const chat = new Container();
		env.tui.addChild(chat);
		chat.addChild(new Text("a", 0, 0));
		chat.addChild(new Text("b", 0, 0));

		const dock = new DynamicText(() => "dock");
		env.tui.addChild(dock);
		env.tui.setDock(dock);

		env.tui.requestRender(true);
		await env.settle();

		// First render should have erase-lines for each row
		const frames = env.analyzed();
		const first = frames[0]!;
		// In full render, every row gets \x1b[2K
		expect(first.eraseLineCount).toBeGreaterThan(0);
		expect(first.hasSyncBrackets).toBe(true);
		env.tui.stop();
	});
});

// ---------------------------------------------------------------------------
// Grid-level tests (2D cell diffing)
// ---------------------------------------------------------------------------

describe("grid: viewport cell diffing", { tags: ["unit"] }, () => {
	it("dock-only change modifies only dock rows in the grid", async () => {
		const env = createFlickerEnv(40, 6);
		const chat = new Container();
		env.tui.addChild(chat);
		for (let i = 0; i < 10; i++) chat.addChild(new Text(`msg-${i}`, 0, 0));

		let tick = 0;
		const dock = new DynamicText(() => `status:${tick}`);
		env.tui.addChild(dock);
		env.tui.setDock(dock);

		env.tui.requestRender(true);
		await env.settle();
		const before = await env.captureGrid();

		tick = 1;
		env.tui.requestRender();
		await env.settle();
		const after = await env.captureGrid();

		// Only the last row (dock) should change in the grid
		env.assertChangedRows(before, after, [5], "dock at row 5");
		env.tui.stop();
	});

	it("no-change render produces identical grid", async () => {
		const env = createFlickerEnv(40, 6);
		const chat = new Container();
		env.tui.addChild(chat);
		chat.addChild(new Text("hello", 0, 0));

		const dock = new Text("footer", 0, 0);
		env.tui.addChild(dock);
		env.tui.setDock(dock);

		env.tui.requestRender(true);
		await env.settle();
		const before = await env.captureGrid();

		env.tui.requestRender();
		await env.settle();
		const after = await env.captureGrid();

		env.assertGridUnchanged(before, after, "identical re-render");
		env.tui.stop();
	});

	it("no cells are blanked during dock-only update", async () => {
		const env = createFlickerEnv(40, 6);
		const chat = new Container();
		env.tui.addChild(chat);
		for (let i = 0; i < 10; i++) chat.addChild(new Text(`msg-${i}`, 0, 0));

		let tick = 0;
		const dock = new DynamicText(() => `dock:${tick}`);
		env.tui.addChild(dock);
		env.tui.setDock(dock);

		env.tui.requestRender(true);
		await env.settle();
		const before = await env.captureGrid();

		tick = 1;
		env.tui.requestRender();
		await env.settle();
		const after = await env.captureGrid();

		env.assertNoBlanking(before, after, "dock tick");
		env.tui.stop();
	});

	it("viewport content is correct after multiple dock ticks", async () => {
		const env = createFlickerEnv(40, 4);
		const chat = new Container();
		env.tui.addChild(chat);
		for (let i = 0; i < 10; i++) chat.addChild(new Text(`line-${i}`, 0, 0));

		let tick = 0;
		const dock = new DynamicText(() => `tick:${tick}`);
		env.tui.addChild(dock);
		env.tui.setDock(dock);

		env.tui.requestRender(true);
		await env.settle();

		for (let i = 1; i <= 5; i++) {
			tick = i;
			env.tui.requestRender();
			await env.settle(20);
		}

		await env.assertViewport(["line-7", "line-8", "line-9", "tick:5"], "after 5 ticks");
		env.tui.stop();
	});
});

describe("grid: scrollback is line-ordered", { tags: ["unit"] }, () => {
	it("archived chat lines appear in scrollback in order", async () => {
		const env = createFlickerEnv(40, 4);
		const chat = new Container();
		env.tui.addChild(chat);

		const dock = new Text("dock", 0, 0);
		env.tui.addChild(dock);
		env.tui.setDock(dock);

		// Add enough lines to push some into scrollback
		for (let i = 0; i < 10; i++) {
			chat.addChild(new Text(`msg-${i}`, 0, 0));
			env.tui.requestRender();
			await env.settle(20);
		}

		const scrollback = await env.captureScrollback();
		// Scrollback should contain the earlier messages in order
		const nonEmpty = scrollback.filter((l) => l.trim().length > 0);
		for (let i = 0; i < nonEmpty.length - 1; i++) {
			const a = nonEmpty[i]!;
			const b = nonEmpty[i + 1]!;
			const numA = parseInt(a.replace(/\D/g, ""), 10);
			const numB = parseInt(b.replace(/\D/g, ""), 10);
			if (!isNaN(numA) && !isNaN(numB)) {
				expect(numA, `scrollback out of order: "${a}" before "${b}"`).toBeLessThan(numB);
			}
		}
		env.tui.stop();
	});
});

// Re-export expect for the self-test
import { expect } from "vitest";
