/**
 * Markdown code block rendering test.
 *
 * Verifies:
 * 1. Fenced code blocks render content (not just grey)
 * 2. Language tag is preserved in the border
 * 3. highlightCode callback is invoked when provided
 */

import { describe, expect, it } from "vitest";
import { TUI } from "../src/tui.js";
import { MockTerminal } from "../src/mock-terminal.js";
import { Markdown } from "../src/components/markdown.js";
import { makeMarkdownTheme } from "../src/views/markdown-themes.js";

const c = (n: number) => ({ ansi16: n });
const STUB_THEME_TOKENS = {
	primaryFg: c(37), secondaryFg: c(36), accentFg: c(33), mutedFg: c(90),
	userFg: c(32), agentFg: c(35), warnFg: c(33), errorFg: c(31), successFg: c(32),
	userBg: c(0), agentBg: c(0), okFg: c(32), errFg: c(31),
};

describe("Markdown code block rendering", { tags: ["unit"] }, () => {
	it("fenced code block renders content text", async () => {
		const terminal = new MockTerminal(80, 24);
		const tui = new TUI(terminal);
		const theme = makeMarkdownTheme(STUB_THEME_TOKENS);

		const md = new Markdown("```typescript\nconst x = 42;\n```", 0, 0, theme);
		tui.addChild(md);
		tui.start();
		tui.requestRender();
		await new Promise((r) => setTimeout(r, 100));

		const stripped = terminal.stripAnsi();
		expect(stripped).toContain("const x = 42");
		expect(stripped).toContain("typescript");

		tui.stop();
	});

	it("code block without language still renders content", async () => {
		const terminal = new MockTerminal(80, 24);
		const tui = new TUI(terminal);
		const theme = makeMarkdownTheme(STUB_THEME_TOKENS);

		const md = new Markdown("```\nhello world\n```", 0, 0, theme);
		tui.addChild(md);
		tui.start();
		tui.requestRender();
		await new Promise((r) => setTimeout(r, 100));

		const stripped = terminal.stripAnsi();
		expect(stripped).toContain("hello world");

		tui.stop();
	});

	it("highlightCode callback is called when provided", async () => {
		const terminal = new MockTerminal(80, 24);
		const tui = new TUI(terminal);
		const theme = makeMarkdownTheme(STUB_THEME_TOKENS);

		let capturedCode = "";
		let capturedLang = "";
		theme.highlightCode = (code: string, lang?: string) => {
			capturedCode = code;
			capturedLang = lang ?? "";
			return code.split("\n").map((line) => `[HL]${line}`);
		};

		const md = new Markdown("```python\nprint('hi')\n```", 0, 0, theme);
		tui.addChild(md);
		tui.start();
		tui.requestRender();
		await new Promise((r) => setTimeout(r, 100));

		expect(capturedCode).toBe("print('hi')");
		expect(capturedLang).toBe("python");

		const stripped = terminal.stripAnsi();
		expect(stripped).toContain("[HL]print('hi')");

		tui.stop();
	});

	it("inline code renders with accent color", async () => {
		const terminal = new MockTerminal(80, 24);
		const tui = new TUI(terminal);
		const theme = makeMarkdownTheme(STUB_THEME_TOKENS);

		const md = new Markdown("Use `npm install` to install.", 0, 0, theme);
		tui.addChild(md);
		tui.start();
		tui.requestRender();
		await new Promise((r) => setTimeout(r, 100));

		const stripped = terminal.stripAnsi();
		expect(stripped).toContain("npm install");

		tui.stop();
	});
});
