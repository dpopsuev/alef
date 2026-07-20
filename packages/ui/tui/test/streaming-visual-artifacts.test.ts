import stripAnsi from "strip-ansi";
import { describe, expect, it } from "vitest";
import { Markdown } from "../src/components/markdown.js";
import { defaultMarkdownTheme } from "./test-themes.js";

describe("streaming visual artifacts", { tags: ["unit"] }, () => {
	it("bold asterisks appear and disappear during streaming", () => {
		const md = new Markdown("", 0, 0, defaultMarkdownTheme);
		const snapshots: string[] = [];

		// Streaming "**bold text**"
		const text = "**bold text**";
		for (let i = 1; i <= text.length; i++) {
			md.setText(text.slice(0, i));
			const lines = md.render(80);
			const visible = stripAnsi(lines.join("\n")).trim();
			snapshots.push(visible);
		}

		// Check transitions:
		// "*" → "**" → "**b" → ... → "**bold tex" → "**bold text" → "**bold text**"
		// The asterisks should eventually disappear when complete
		expect(snapshots[0]).toContain("-"); // "*" parsed as list bullet by marked
		expect(snapshots[1]).toBe("**"); // two asterisks, not yet a list item
		expect(snapshots[snapshots.length - 1]).not.toContain("**"); // complete = no visible asterisks
	});

	it("code fence markers visible until closed", () => {
		const md = new Markdown("", 0, 0, defaultMarkdownTheme);
		const snapshots: string[] = [];

		// Streaming "```js\ncode\n```"
		const text = "```js\ncode\n```";
		for (let i = 1; i <= text.length; i++) {
			md.setText(text.slice(0, i));
			const lines = md.render(80);
			const visible = stripAnsi(lines.join("\n"));
			snapshots.push(visible);
		}

		// Incomplete code blocks render with border chrome (no raw backticks)
		const earlySnapshot = snapshots[5]!; // "```js" rendered as bordered block
		expect(earlySnapshot).toContain("js");

		// Complete code block has formatted borders and content
		const finalSnapshot = snapshots[snapshots.length - 1]!;
		expect(finalSnapshot).toContain("code");
	});

	it("list bullet positions shift as items complete", () => {
		const md = new Markdown("", 0, 0, defaultMarkdownTheme);
		const positions: number[] = [];

		// Streaming "- item 1\n- item 2"
		const text = "- item 1\n- item 2";
		for (let i = 1; i <= text.length; i++) {
			md.setText(text.slice(0, i));
			const lines = md.render(80);
			const visible = lines.join("\n");
			// Find position of first bullet character (if any)
			const bulletIndex = visible.indexOf("-");
			positions.push(bulletIndex);
		}

		// Bullet positions should stabilize once list structure is recognized
		const lastFew = positions.slice(-5);
		const allSame = lastFew.every((p) => p === lastFew[0]);
		expect(allSame).toBe(true);
	});

	it("re-parsing cost increases with text length", () => {
		const md = new Markdown("", 0, 0, defaultMarkdownTheme);

		// Generate long document
		const paragraphs = Array.from(
			{ length: 50 },
			(_, i) => `## Section ${i}\n\nParagraph ${i} with some **bold** and \`code\` text.`,
		).join("\n\n");

		const start1 = performance.now();
		md.setText(paragraphs.slice(0, 100));
		md.render(80);
		const time1 = performance.now() - start1;

		const start2 = performance.now();
		md.setText(paragraphs); // Full text
		md.render(80);
		const time2 = performance.now() - start2;

		// Full reparse should take longer than partial
		expect(time2).toBeGreaterThan(time1);
	});
});
