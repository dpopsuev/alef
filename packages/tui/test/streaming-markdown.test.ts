import stripAnsi from "strip-ansi";
import { describe, expect, it } from "vitest";
import { Markdown } from "../src/components/markdown.js";
import { defaultMarkdownTheme } from "./test-themes.js";

describe("streaming markdown rendering", { tags: ["unit"] }, () => {
	it("handles incomplete code block gracefully", () => {
		const md = new Markdown("", 0, 0, defaultMarkdownTheme);

		// Simulate streaming "```js\nconst x = 1;\n```" character by character
		const fullText = "```js\nconst x = 1;\n```";
		for (let i = 1; i <= fullText.length; i++) {
			const partial = fullText.slice(0, i);
			md.setText(partial);
			const lines = md.render(80);
			// Should not throw, even with incomplete code fence
			expect(lines).toBeDefined();
		}

		const finalLines = md.render(80);
		const text = finalLines
			.map((l) => stripAnsi(l).trim())
			.filter(Boolean)
			.join("\n");
		expect(text).toContain("const x = 1");
	});

	it("handles incomplete bold gracefully", () => {
		const md = new Markdown("", 0, 0, defaultMarkdownTheme);

		// Streaming "**bold text**"
		const fullText = "**bold text**";
		for (let i = 1; i <= fullText.length; i++) {
			const partial = fullText.slice(0, i);
			md.setText(partial);
			const lines = md.render(80);
			expect(lines).toBeDefined();
		}

		const finalLines = md.render(80);
		expect(finalLines.length).toBeGreaterThan(0);
	});

	it("handles incomplete list item gracefully", () => {
		const md = new Markdown("", 0, 0, defaultMarkdownTheme);

		// Streaming "- Item 1\n- Item 2"
		const fullText = "- Item 1\n- Item 2";
		for (let i = 1; i <= fullText.length; i++) {
			const partial = fullText.slice(0, i);
			md.setText(partial);
			const lines = md.render(80);
			expect(lines).toBeDefined();
		}

		const finalLines = md.render(80);
		const text = finalLines
			.map((l) => stripAnsi(l).trim())
			.filter(Boolean)
			.join("\n");
		expect(text).toContain("Item 1");
		expect(text).toContain("Item 2");
	});

	it("handles incomplete blockquote gracefully", () => {
		const md = new Markdown("", 0, 0, defaultMarkdownTheme);

		// Streaming "> Quote line 1\n> Quote line 2"
		const fullText = "> Quote line 1\n> Quote line 2";
		for (let i = 1; i <= fullText.length; i++) {
			const partial = fullText.slice(0, i);
			md.setText(partial);
			const lines = md.render(80);
			expect(lines).toBeDefined();
		}

		const finalLines = md.render(80);
		const text = finalLines
			.map((l) => stripAnsi(l).trim())
			.filter(Boolean)
			.join("\n");
		expect(text).toContain("Quote line 1");
		expect(text).toContain("Quote line 2");
	});

	it("caches render output between identical setText calls", () => {
		const md = new Markdown("# Heading", 0, 0, defaultMarkdownTheme);

		const lines1 = md.render(80);
		const lines2 = md.render(80);

		// Cache should return identical reference
		expect(lines1).toBe(lines2);
	});

	it("invalidates cache when text changes", () => {
		const md = new Markdown("# Heading", 0, 0, defaultMarkdownTheme);

		const lines1 = md.render(80);
		md.setText("# Different");
		const lines2 = md.render(80);

		// Cache should return different reference
		expect(lines1).not.toBe(lines2);
	});
});
