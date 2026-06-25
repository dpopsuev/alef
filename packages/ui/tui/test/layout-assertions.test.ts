/**
 * Layout assertions — deterministic tests for component ordering,
 * total line counts, and viewport behavior.
 *
 * These tests assert on the STRUCTURE of rendered output,
 * not pixel-level content.
 */

import { describe, expect, it } from "vitest";
import { Container, GrowSpacer, Text, TUI } from "../src/index.js";
import { VirtualTerminal } from "./virtual-terminal.js";

const TERMINAL_ROWS = 24;
const TERMINAL_COLS = 80;

describe("Layout assertions", { tags: ["unit"] }, () => {
	describe("component ordering in render output", () => {
		it("children render in insertion order", () => {
			const container = new Container();
			container.addChild(new Text("header", 0, 0));
			container.addChild(new Text("body", 0, 0));
			container.addChild(new Text("footer", 0, 0));

			const lines = container.render(TERMINAL_COLS);
			const headerIdx = lines.findIndex((l) => l.includes("header"));
			const bodyIdx = lines.findIndex((l) => l.includes("body"));
			const footerIdx = lines.findIndex((l) => l.includes("footer"));

			expect(headerIdx).toBeLessThan(bodyIdx);
			expect(bodyIdx).toBeLessThan(footerIdx);
		});

		it("GrowSpacer between content and footer pushes footer down", () => {
			const container = new Container();
			const content = new Text("content", 0, 0);
			const spacer = new GrowSpacer(2);
			const footer = new Text("footer", 0, 0);

			container.addChild(content);
			container.addChild(spacer);
			container.addChild(footer);

			const lines = container.render(TERMINAL_COLS);
			const contentIdx = lines.findIndex((l) => l.includes("content"));
			const footerIdx = lines.findIndex((l) => l.includes("footer"));

			expect(contentIdx).toBeGreaterThanOrEqual(0);
			expect(footerIdx).toBeGreaterThan(contentIdx);
		});
	});

	describe("total rendered line count vs terminal height", () => {
		it("GrowSpacer with no content produces blank lines filling terminal", () => {
			const spacer = new GrowSpacer(2);
			const lines = spacer.render(TERMINAL_COLS);

			// GrowSpacer fills terminalRows - fixedLines - contentLines
			// With fixedLines=2, contentLines=0: fills rows-2 blank lines
			// In test env process.stdout.rows is undefined, fallback = 24
			const expectedRows = (process.stdout.rows ?? 24) - 2;
			expect(lines.length).toBe(expectedRows);
		});

		it("GrowSpacer with contentLines set reduces blank lines", () => {
			const spacer = new GrowSpacer(2);
			spacer.setContentLines(10);
			const lines = spacer.render(TERMINAL_COLS);

			expect(lines.length).toBe(Math.max(0, (process.stdout.rows ?? 24) - 2 - 10));
		});

		it("GrowSpacer at startup should NOT produce more lines than terminal height", () => {
			// THE BUG: GrowSpacer(4) produces rows-4=20 blank lines.
			// The real TUI has ~10 sibling components adding lines.
			// Total exceeds viewport, pushing content above scroll.
			const container = new Container();
			container.addChild(new Text("splash", 0, 0));
			container.addChild(new Text("separator-1", 0, 0));
			container.addChild(new Text("in-flight", 0, 0));
			container.addChild(new Text("chunk", 0, 0));
			container.addChild(new Text("inspector", 0, 0));
			container.addChild(new Text("status", 0, 0));
			container.addChild(new Text("widget-above", 0, 0));
			container.addChild(new Text("editor-top", 0, 0));
			container.addChild(new Text("editor-input", 0, 0));
			container.addChild(new Text("editor-bottom", 0, 0));
			container.addChild(new Text("command-grid", 0, 0));
			container.addChild(new Text("widget-below", 0, 0));
			container.addChild(new Text("hint-bar", 0, 0));

			const siblingCount = 14; // 13 above + 1 footer below
			const spacer = new GrowSpacer(siblingCount);
			container.addChild(spacer);

			container.addChild(new Text("footer", 0, 0));

			const lines = container.render(TERMINAL_COLS);
			const terminalHeight = process.stdout.rows ?? 24;

			// spacer should fill only remaining space: rows - siblingCount
			// Total: siblingCount + spacer + 0 contentLines = terminalHeight
			expect(lines.length).toBeLessThanOrEqual(terminalHeight);
		});
	});

	describe("TUI viewport with VirtualTerminal", () => {
		it("footer visible in viewport at startup with no content", async () => {
			const terminal = new VirtualTerminal(TERMINAL_COLS, TERMINAL_ROWS);
			const tui = new TUI(terminal);

			const footer = new Text("──footer──", 0, 0);
			tui.addChild(footer);

			tui.start();
			await terminal.waitForRender();

			const viewport = await terminal.flushAndGetViewport();
			const footerInViewport = viewport.some((line) => line.includes("footer"));

			tui.stop();
			expect(footerInViewport).toBe(true);
		});

		it("GrowSpacer does not push footer out of viewport", async () => {
			const terminal = new VirtualTerminal(TERMINAL_COLS, TERMINAL_ROWS);
			const tui = new TUI(terminal);

			const spacer = new GrowSpacer(4);
			const footer = new Text("──footer──", 0, 0);

			tui.addChild(spacer);
			tui.addChild(footer);

			tui.start();
			await terminal.waitForRender();

			const viewport = await terminal.flushAndGetViewport();
			const footerInViewport = viewport.some((line) => line.includes("footer"));

			tui.stop();
			expect(footerInViewport).toBe(true);
		});

		it("content + GrowSpacer + footer all visible in viewport", async () => {
			const terminal = new VirtualTerminal(TERMINAL_COLS, TERMINAL_ROWS);
			const tui = new TUI(terminal);

			const content = new Text("hello-content", 0, 0);
			const spacer = new GrowSpacer(4);
			spacer.setContentLines(1);
			const footer = new Text("──footer──", 0, 0);

			tui.addChild(content);
			tui.addChild(spacer);
			tui.addChild(footer);

			tui.start();
			await terminal.waitForRender();

			const viewport = await terminal.flushAndGetViewport();
			const contentVisible = viewport.some((line) => line.includes("hello-content"));
			const footerVisible = viewport.some((line) => line.includes("footer"));

			tui.stop();
			expect(contentVisible).toBe(true);
			expect(footerVisible).toBe(true);
		});
	});

	describe("boot layout — components clustered at top on tall viewport", () => {
		const TALL_ROWS = 50;

		it("output + editor + footer cluster in the first few lines", async () => {
			const terminal = new VirtualTerminal(TERMINAL_COLS, TALL_ROWS);
			const tui = new TUI(terminal);

			tui.addChild(new Text("output-area", 0, 0));
			tui.addChild(new Text("─".repeat(TERMINAL_COLS), 0, 0));
			tui.addChild(new Text("type-here", 0, 0));
			tui.addChild(new Text("model-info", 0, 0));

			tui.start();
			await terminal.waitForRender();

			const viewport = await terminal.flushAndGetViewport();
			const footerRow = viewport.findIndex((l) => l.includes("model-info"));

			tui.stop();

			expect(footerRow).toBeGreaterThanOrEqual(0);
			expect(footerRow).toBeLessThan(10);
		});

		it("GrowSpacer on tall viewport does NOT push footer to bottom", async () => {
			const terminal = new VirtualTerminal(TERMINAL_COLS, TALL_ROWS);
			const tui = new TUI(terminal);

			tui.addChild(new Text("output-area", 0, 0));
			const spacer = new GrowSpacer(4);
			tui.addChild(spacer);
			tui.addChild(new Text("model-info", 0, 0));

			tui.start();
			await terminal.waitForRender();

			const viewport = await terminal.flushAndGetViewport();
			const footerRow = viewport.findIndex((l) => l.includes("model-info"));

			tui.stop();

			// BUG: spacer fills 50-4=46 blanks, pushing footer to row 47
			expect(footerRow).toBeLessThan(TALL_ROWS - 5);
		});

		it("GrowSpacer disabled at boot produces zero blank lines", async () => {
			const terminal = new VirtualTerminal(TERMINAL_COLS, TALL_ROWS);
			const tui = new TUI(terminal);

			tui.addChild(new Text("hello", 0, 0));
			const spacer = new GrowSpacer(2);
			spacer.setEnabled(false);
			tui.addChild(spacer);
			tui.addChild(new Text("footer", 0, 0));

			tui.start();
			await terminal.waitForRender();

			const viewport = await terminal.flushAndGetViewport();
			const contentRow = viewport.findIndex((l) => l.includes("hello"));
			const footerRow = viewport.findIndex((l) => l.includes("footer"));

			tui.stop();

			expect(footerRow).toBe(contentRow + 1);
		});

		it("GrowSpacer enables after content grows — footer moves to bottom", async () => {
			const terminal = new VirtualTerminal(TERMINAL_COLS, 10);
			const tui = new TUI(terminal);

			const spacer = new GrowSpacer(3);
			spacer.setEnabled(false);

			tui.addChild(new Text("line-1", 0, 0));
			tui.addChild(new Text("line-2", 0, 0));
			tui.addChild(new Text("line-3", 0, 0));
			tui.addChild(new Text("line-4", 0, 0));
			tui.addChild(new Text("line-5", 0, 0));
			tui.addChild(spacer);
			tui.addChild(new Text("footer", 0, 0));

			tui.start();
			await terminal.waitForRender();

			let viewport = await terminal.flushAndGetViewport();
			let footerRow = viewport.findIndex((l) => l.includes("footer"));

			expect(footerRow).toBeLessThan(7);

			spacer.setEnabled(true);
			spacer.setSiblingLines(6);
			tui.requestRender();
			await terminal.waitForRender();

			viewport = await terminal.flushAndGetViewport();
			footerRow = viewport.findIndex((l) => l.includes("footer"));

			expect(footerRow).toBeGreaterThan(7);
		});
	});

	describe("progressive output — footer descends as content grows", () => {
		it("each message pushes footer down by one row", async () => {
			const terminal = new VirtualTerminal(TERMINAL_COLS, 15);
			const tui = new TUI(terminal);

			const output = new Container();
			const spacer = new GrowSpacer(3);
			spacer.setEnabled(false);
			const editor = new Text("──editor──", 0, 0);
			const footer = new Text("──footer──", 0, 0);

			tui.addChild(output);
			tui.addChild(spacer);
			tui.addChild(editor);
			tui.addChild(footer);

			tui.start();
			await terminal.waitForRender();

			const footerPositions: number[] = [];

			// Tick 0: no content
			let viewport = await terminal.flushAndGetViewport();
			footerPositions.push(viewport.findIndex((l) => l.includes("footer")));

			// Add messages one by one
			for (let i = 1; i <= 5; i++) {
				output.addChild(new Text(`msg-${i}`, 0, 0));
				tui.requestRender();
				await terminal.waitForRender();

				viewport = await terminal.flushAndGetViewport();
				footerPositions.push(viewport.findIndex((l) => l.includes("footer")));
			}

			tui.stop();

			// Footer should descend monotonically as content grows
			for (let i = 1; i < footerPositions.length; i++) {
				expect(footerPositions[i]).toBeGreaterThanOrEqual(footerPositions[i - 1]);
			}

			// After 5 messages: footer should be at row 5+1+1 = 7 (msgs + editor + footer)
			expect(footerPositions[5]).toBeGreaterThan(footerPositions[0]);
		});

		it("editor stays directly above footer at every tick", async () => {
			const terminal = new VirtualTerminal(TERMINAL_COLS, 15);
			const tui = new TUI(terminal);

			const output = new Container();
			const editor = new Text("──editor──", 0, 0);
			const footer = new Text("──footer──", 0, 0);

			tui.addChild(output);
			tui.addChild(editor);
			tui.addChild(footer);

			tui.start();
			await terminal.waitForRender();

			for (let i = 1; i <= 8; i++) {
				output.addChild(new Text(`message-${i}`, 0, 0));
				tui.requestRender();
				await terminal.waitForRender();

				const viewport = await terminal.flushAndGetViewport();
				const editorRow = viewport.findIndex((l) => l.includes("editor"));
				const footerRow = viewport.findIndex((l) => l.includes("footer"));

				// Editor and footer must be adjacent at every tick
				if (editorRow >= 0 && footerRow >= 0) {
					expect(footerRow).toBe(editorRow + 1);
				}
			}

			tui.stop();
		});

		it("output scrollback grows while footer stays in viewport", async () => {
			const terminal = new VirtualTerminal(TERMINAL_COLS, 10);
			const tui = new TUI(terminal);

			const output = new Container();
			const footer = new Text("──footer──", 0, 0);

			tui.addChild(output);
			tui.addChild(footer);

			tui.start();
			await terminal.waitForRender();

			// Add 20 messages — more than viewport height
			for (let i = 1; i <= 20; i++) {
				output.addChild(new Text(`line-${i}`, 0, 0));
				tui.requestRender();
				await terminal.waitForRender();
			}

			const viewport = await terminal.flushAndGetViewport();
			const scrollBuffer = terminal.getScrollBuffer();
			const footerInViewport = viewport.some((l) => l.includes("footer"));

			tui.stop();

			// Scrollback should be larger than viewport
			expect(scrollBuffer.length).toBeGreaterThan(10);
			// Footer must still be visible in viewport
			expect(footerInViewport).toBe(true);
		});
	});
});
