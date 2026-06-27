/**
 * Test: does Markdown component produce visible output when rendered?
 */

import { describe, expect, it } from "vitest";
import { TUI } from "../src/tui.js";
import { MockTerminal } from "../src/mock-terminal.js";
import { Markdown } from "../src/components/markdown.js";
import type { MarkdownTheme } from "../src/components/markdown.js";

const id = (s: string) => s;
const PLAIN_THEME: MarkdownTheme = {
	bold: id,
	italic: id,
	strikethrough: id,
	underline: id,
	heading: id,
	code: id,
	codeBlock: id,
	codeBlockBorder: id,
	link: id,
	linkUrl: id,
	quote: id,
	quoteBorder: id,
	hr: id,
	listBullet: id,
};

describe("Markdown component rendering", { tags: ["unit"] }, () => {
	it("Markdown with setText renders text to terminal", async () => {
		const terminal = new MockTerminal(80, 24);
		const tui = new TUI(terminal);

		const md = new Markdown("initial text", 0, 0, PLAIN_THEME);
		tui.addChild(md);

		tui.start();

		// Directly call render to check what the component tree produces
		const lines = tui.render(80);
		console.log("direct render lines:", lines.length, lines);

		tui.requestRender();
		await new Promise((r) => setTimeout(r, 100));

		const stripped = terminal.stripAnsi();
		console.log("initial render stripped:", JSON.stringify(stripped.slice(0, 200)));
		console.log("raw output count:", terminal.output.length);
		expect(stripped).toContain("initial text");

		// Now update text
		terminal.output.length = 0; // clear
		md.setText("updated text content");
		tui.requestRender();
		await new Promise((r) => setTimeout(r, 100));

		const updated = terminal.stripAnsi();
		console.log("updated render stripped:", updated.slice(0, 100));
		expect(updated).toContain("updated text content");

		tui.stop();
	});

	it("Markdown added after start renders on next requestRender", async () => {
		const terminal = new MockTerminal(80, 24);
		const tui = new TUI(terminal);

		tui.start();
		tui.requestRender();
		await new Promise((r) => setTimeout(r, 50));

		// Add Markdown AFTER initial render
		const md = new Markdown("late addition", 0, 0, PLAIN_THEME);
		tui.addChild(md);
		tui.requestRender();
		await new Promise((r) => setTimeout(r, 100));

		const stripped = terminal.stripAnsi();
		console.log("late addition stripped:", stripped.slice(0, 100));
		expect(stripped).toContain("late addition");

		tui.stop();
	});
});
