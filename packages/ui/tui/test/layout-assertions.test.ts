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
});
