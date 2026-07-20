/**
 * Regression: mid-frame line insertion causes rendering corruption.
 *
 * When lines are inserted in the middle of the frame (e.g., a tool result
 * arriving in the chat area above the input), the differential renderer
 * can produce garbled output -- lines from different parts of the frame
 * bleed into each other, duplicate content appears, or the footer drifts
 * from its docked position.
 *
 * Critical: after the initial full render, subsequent renders must use
 * requestRender() (not requestRender(true)) to exercise the differential
 * path. requestRender(true) forces a full redraw which masks the bug.
 */

import { describe, expect, it } from "vitest";
import type { Component } from "../src/component.js";
import { Text } from "../src/components/text.js";
import { Container, TUI } from "../src/tui.js";
import { applyBackgroundToLine } from "../src/utils.js";
import { DynamicText } from "../src/views/index.js";
import { VirtualTerminal } from "./virtual-terminal.js";

async function settle(ms = 40): Promise<void> {
	await new Promise<void>((r) => process.nextTick(r));
	await new Promise<void>((r) => setTimeout(r, ms));
	await new Promise<void>((r) => process.nextTick(r));
}

/**
 * Assert no non-empty line appears on consecutive viewport rows.
 * Two identical lines from separate components (e.g. two diff headers)
 * are fine; the corruption signature is the same line repeated adjacently.
 */
function expectNoAdjacentDuplicates(viewport: string[], label: string): void {
	for (let i = 1; i < viewport.length; i++) {
		const prev = viewport[i - 1]!.trim();
		const curr = viewport[i]!.trim();
		if (prev && curr && prev === curr) {
			expect.fail(`${label}: adjacent duplicate at rows ${i - 1}/${i}: "${prev}"`);
		}
	}
}

const GREEN_BG = "\x1b[42m";
const RED_BG = "\x1b[41m";
const RESET = "\x1b[0m";

/**
 * Simulates DiffBlock: renders lines with full-width ANSI background fills.
 * Every line is padded to terminal width with background color escape
 * sequences, matching what the real DiffBlock produces.
 */
class FakeDiffBlock implements Component {
	constructor(
		private readonly addLines: string[],
		private readonly remLines: string[],
	) {}

	invalidate(): void {}

	render(width: number): string[] {
		const out: string[] = [];
		out.push("Edited file.ts +N -M");
		for (const line of this.remLines) {
			const styled = `${RED_BG}-${line}${RESET}`;
			out.push(applyBackgroundToLine(styled, width, (t) => `${RED_BG}${t}${RESET}`));
		}
		for (const line of this.addLines) {
			const styled = `${GREEN_BG}+${line}${RESET}`;
			out.push(applyBackgroundToLine(styled, width, (t) => `${GREEN_BG}${t}${RESET}`));
		}
		out.push(" ".repeat(width));
		return out;
	}
}

describe("mid-frame line insertion (differential render path)", { tags: ["unit"] }, () => {
	it("inserting plain lines via differential render", async () => {
		const terminal = new VirtualTerminal(40, 12);
		const tui = new TUI(terminal);
		terminal.start(
			() => {},
			() => tui.requestRender(),
		);
		tui.start();

		const chat = new Container();
		tui.addChild(chat);

		for (let i = 0; i < 5; i++) {
			chat.addChild(new Text(`msg-${i}`, 0, 0));
		}

		const footer = new DynamicText(() => "== INPUT ==");
		tui.addChild(footer);
		tui.setDock(footer);

		// First render: force to establish baseline
		tui.requestRender(true);
		await settle();

		// Insert lines -- use non-force render to hit differential path
		const toolResult = new Container();
		for (let j = 0; j < 8; j++) {
			toolResult.addChild(new Text(`tool-line-${j}`, 0, 0));
		}
		chat.insertAt(3, toolResult);

		tui.requestRender(); // differential
		await settle();

		const after = await terminal.flushAndGetViewport();
		expect(after[after.length - 1], "footer must be on last line").toContain("INPUT");

		const footerCount = after.filter((l) => l.includes("INPUT")).length;
		expect(footerCount, "footer should appear exactly once").toBe(1);

		expectNoAdjacentDuplicates(after, "after insert");

		tui.stop();
	});

	it("large insertion past viewport via differential render", async () => {
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TUI(terminal);
		terminal.start(
			() => {},
			() => tui.requestRender(),
		);
		tui.start();

		const chat = new Container();
		tui.addChild(chat);

		for (let i = 0; i < 4; i++) {
			chat.addChild(new Text(`line-${i}`, 0, 0));
		}

		const footer = new DynamicText(() => "FOOTER");
		tui.addChild(footer);
		tui.setDock(footer);

		tui.requestRender(true);
		await settle();

		const block = new Container();
		for (let j = 0; j < 12; j++) {
			block.addChild(new Text(`inserted-${j}`, 0, 0));
		}
		chat.insertAt(2, block);

		tui.requestRender(); // differential
		await settle();

		const viewport = await terminal.flushAndGetViewport();
		expect(viewport[viewport.length - 1], "footer on last line").toContain("FOOTER");
		expectNoAdjacentDuplicates(viewport, "after large insert");

		tui.stop();
	});

	it("diff block with ANSI backgrounds via differential render", async () => {
		const terminal = new VirtualTerminal(60, 14);
		const tui = new TUI(terminal);
		terminal.start(
			() => {},
			() => tui.requestRender(),
		);
		tui.start();

		const chat = new Container();
		tui.addChild(chat);

		chat.addChild(new Text("The fix is straightforward.", 0, 0));
		chat.addChild(new Text("Here is the change:", 0, 0));

		const footer = new DynamicText(() => "-- INSERT --");
		tui.addChild(footer);
		tui.setDock(footer);

		tui.requestRender(true);
		await settle();

		// First tool result -- differential render
		chat.addChild(new Text("fs.edit  logger.ts  122ms", 0, 0));
		chat.addChild(
			new FakeDiffBlock(
				["const level = willUseTui ? 'silent' : resolveLevel(debug);"],
				["const level = willUseTui && !debug ? 'silent' : resolveLevel(debug);"],
			),
		);

		tui.requestRender(); // differential
		await settle();

		const mid = await terminal.flushAndGetViewport();
		expect(mid[mid.length - 1], "footer on last line after diff block").toContain("INSERT");
		expectNoAdjacentDuplicates(mid, "after diff block");

		// Second tool result -- another differential render
		chat.addChild(new Text("All checks pass.", 0, 0));
		chat.addChild(new Text("fs.exec  git commit  3.2s", 0, 0));
		chat.addChild(
			new FakeDiffBlock(
				["fix: suppress pino worker transport"],
				[],
			),
		);

		tui.requestRender(); // differential
		await settle();

		const final = await terminal.flushAndGetViewport();
		expect(final[final.length - 1], "footer on last line after second batch").toContain("INSERT");
		expectNoAdjacentDuplicates(final, "after second batch");

		tui.stop();
	});

	it("rapid sequential appends with styled content via differential render", async () => {
		const terminal = new VirtualTerminal(50, 10);
		const tui = new TUI(terminal);
		terminal.start(
			() => {},
			() => tui.requestRender(),
		);
		tui.start();

		const chat = new Container();
		tui.addChild(chat);
		chat.addChild(new Text("Starting batch...", 0, 0));

		const footer = new DynamicText(() => "DOCK");
		tui.addChild(footer);
		tui.setDock(footer);

		tui.requestRender(true);
		await settle();

		for (let i = 0; i < 5; i++) {
			chat.addChild(new Text(`tool-${i}  file-${i}.ts  ${i * 100}ms`, 0, 0));
			chat.addChild(
				new FakeDiffBlock(
					[`new content for file ${i}`],
					[`old content for file ${i}`],
				),
			);

			tui.requestRender(); // differential each time
			await settle();

			const viewport = await terminal.flushAndGetViewport();
			expect(viewport[viewport.length - 1], `footer on last line after tool-${i}`).toContain("DOCK");
			expectNoAdjacentDuplicates(viewport, `after tool-${i}`);
		}

		tui.stop();
	});

	it("sequential mid-frame insertions via differential render", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		terminal.start(
			() => {},
			() => tui.requestRender(),
		);
		tui.start();

		const chat = new Container();
		tui.addChild(chat);
		chat.addChild(new Text("first", 0, 0));
		chat.addChild(new Text("last", 0, 0));

		const footer = new DynamicText(() => "DOCK");
		tui.addChild(footer);
		tui.setDock(footer);

		tui.requestRender(true);
		await settle();

		for (let batch = 0; batch < 3; batch++) {
			chat.insertAt(chat.children.length - 1, new Text(`batch-${batch}`, 0, 0));

			tui.requestRender(); // differential
			await settle();
		}

		const viewport = await terminal.flushAndGetViewport();
		expect(viewport[viewport.length - 1], "footer on last line").toContain("DOCK");
		expectNoAdjacentDuplicates(viewport, "after sequential inserts");

		const allText = terminal.getScrollBuffer().join("\n");
		expect(allText).toContain("batch-0");
		expect(allText).toContain("batch-2");
		expect(allText).toContain("first");
		expect(allText).toContain("last");

		tui.stop();
	});
});
