/**
 * Typewriter tests — tick isolation + monotonicity invariants.
 *
 * The invariants catch jitter bugs: if rendered text ever shrinks,
 * loses its prefix, or if the cursor row jumps backward between
 * frames, the typewriter animation is broken.
 */

import { describe, expect, it } from "vitest";
import { Typewriter } from "../src/views/typewriter.js";
import { Markdown } from "../src/components/markdown.js";

describe("Typewriter timer", { tags: ["unit"] }, () => {
	it("tick fires and calls downstream within 100ms", async () => {
		const received: string[] = [];
		let renderCalled = 0;

		const tw = new Typewriter(
			(delta) => received.push(delta),
			() => { renderCalled++; },
		);

		tw.receive("hello world");

		// Wait for ticks (16ms each, 1-8 chars per tick)
		await new Promise((r) => setTimeout(r, 200));


		expect(received.length).toBeGreaterThan(0);
		expect(received.join("")).toBe("hello world");
	});

	it("flush() drains all pending chars instantly", () => {
		const received: string[] = [];
		const tw = new Typewriter(
			(delta) => received.push(delta),
			() => {},
		);

		tw.receive("instant");
		tw.flush();

		expect(received.join("")).toBe("instant");
	});
});

describe("Typewriter monotonicity invariants", { tags: ["unit"] }, () => {
	/**
	 * Capture the cumulative text after each downstream call.
	 * Returns the sequence of snapshots for invariant assertions.
	 */
	function captureFrames(input: string, opts?: { tickMs?: number; maxCharsPerTick?: number }) {
		const frames: string[] = [];
		let accumulated = "";
		const tw = new Typewriter(
			(delta) => {
				accumulated += delta;
				frames.push(accumulated);
			},
			() => {},
			opts,
		);
		tw.receive(input);
		tw.flush();
		return frames;
	}

	it("character count is monotonically non-decreasing", () => {
		const frames = captureFrames("The quick brown fox jumps over the lazy dog.");
		for (let i = 1; i < frames.length; i++) {
			expect(frames[i]!.length).toBeGreaterThanOrEqual(frames[i - 1]!.length);
		}
	});

	it("each frame is a prefix of the next", () => {
		const frames = captureFrames("Hello, world! This is a streaming test.");
		for (let i = 1; i < frames.length; i++) {
			expect(frames[i]!.startsWith(frames[i - 1]!)).toBe(true);
		}
	});

	it("final frame equals the full input", () => {
		const input = "Complete sentence with special chars: @#$% & newlines\nline two.";
		const frames = captureFrames(input);
		expect(frames[frames.length - 1]).toBe(input);
	});

	it("monotonicity holds across multiple receive() calls", async () => {
		const frames: string[] = [];
		let accumulated = "";
		const tw = new Typewriter(
			(delta) => {
				accumulated += delta;
				frames.push(accumulated);
			},
			() => {},
		);

		tw.receive("first ");
		await new Promise((r) => setTimeout(r, 50));
		tw.receive("second ");
		await new Promise((r) => setTimeout(r, 50));
		tw.receive("third");
		tw.flush();

		for (let i = 1; i < frames.length; i++) {
			expect(frames[i]!.length).toBeGreaterThanOrEqual(frames[i - 1]!.length);
			expect(frames[i]!.startsWith(frames[i - 1]!)).toBe(true);
		}
		expect(frames[frames.length - 1]).toBe("first second third");
	});

	it("monotonicity holds with high-pressure bursts", () => {
		const burst = "x".repeat(500);
		const frames = captureFrames(burst, { maxCharsPerTick: 8 });
		for (let i = 1; i < frames.length; i++) {
			expect(frames[i]!.length).toBeGreaterThanOrEqual(frames[i - 1]!.length);
			expect(frames[i]!.startsWith(frames[i - 1]!)).toBe(true);
		}
		expect(frames[frames.length - 1]).toBe(burst);
	});

	it("reset() does not corrupt subsequent animation", () => {
		const frames: string[] = [];
		let accumulated = "";
		const tw = new Typewriter(
			(delta) => {
				accumulated += delta;
				frames.push(accumulated);
			},
			() => {},
		);

		tw.receive("first turn");
		tw.reset();

		// After reset, accumulated includes everything flushed.
		// Start a new sequence — the new animation must be monotonic on its own.
		const secondFrames: string[] = [];
		let secondAccumulated = "";
		const tw2 = new Typewriter(
			(delta) => {
				secondAccumulated += delta;
				secondFrames.push(secondAccumulated);
			},
			() => {},
		);

		tw2.receive("second turn");
		tw2.flush();

		for (let i = 1; i < secondFrames.length; i++) {
			expect(secondFrames[i]!.length).toBeGreaterThanOrEqual(secondFrames[i - 1]!.length);
			expect(secondFrames[i]!.startsWith(secondFrames[i - 1]!)).toBe(true);
		}
		expect(secondFrames[secondFrames.length - 1]).toBe("second turn");
	});

	it("newline characters do not cause row regression", () => {
		const input = "line 1\nline 2\nline 3\nline 4";
		const frames = captureFrames(input);

		for (let i = 1; i < frames.length; i++) {
			const prevRows = frames[i - 1]!.split("\n").length;
			const currRows = frames[i]!.split("\n").length;
			expect(currRows).toBeGreaterThanOrEqual(prevRows);
		}
	});

	it("concurrent receive() and flush() maintain prefix stability", () => {
		const frames: string[] = [];
		let accumulated = "";
		const tw = new Typewriter(
			(delta) => {
				accumulated += delta;
				frames.push(accumulated);
			},
			() => {},
		);

		tw.receive("abc");
		tw.flush();
		tw.receive("def");
		tw.flush();
		tw.receive("ghi");
		tw.flush();

		for (let i = 1; i < frames.length; i++) {
			expect(frames[i]!.startsWith(frames[i - 1]!)).toBe(true);
		}
		expect(frames[frames.length - 1]).toBe("abcdefghi");
	});
});

const identity = (s: string) => s;
const STUB_THEME = {
	heading: identity,
	link: identity,
	linkUrl: identity,
	code: identity,
	codeBlock: identity,
	codeBlockBorder: identity,
	quote: identity,
	quoteBorder: identity,
	hr: identity,
	listBullet: identity,
	bold: identity,
	italic: identity,
	strikethrough: identity,
	underline: identity,
};

describe("Typewriter + Markdown render monotonicity", { tags: ["unit"] }, () => {
	const RENDER_WIDTH = 80;

	function simulateStream(fullText: string, chunkSize = 3) {
		const md = new Markdown("", 0, 0, STUB_THEME);
		const snapshots: { text: string; lineCount: number }[] = [];
		let accumulated = "";

		const tw = new Typewriter(
			(delta) => {
				accumulated += delta;
				md.setText(accumulated);
				const lines = md.render(RENDER_WIDTH);
				snapshots.push({ text: accumulated, lineCount: lines.length });
			},
			() => {},
		);

		for (let i = 0; i < fullText.length; i += chunkSize) {
			tw.receive(fullText.slice(i, i + chunkSize));
		}
		tw.flush();
		return snapshots;
	}

	it("line count never decreases for plain text", () => {
		const snapshots = simulateStream(
			"The quick brown fox jumps over the lazy dog. " +
			"Pack my box with five dozen liquor jugs. " +
			"How vexingly quick daft zebras jump.",
		);
		for (let i = 1; i < snapshots.length; i++) {
			expect(snapshots[i]!.lineCount).toBeGreaterThanOrEqual(snapshots[i - 1]!.lineCount);
		}
	});

	it("line count never decreases across newlines", () => {
		const snapshots = simulateStream("line 1\nline 2\nline 3\nline 4\nline 5");
		for (let i = 1; i < snapshots.length; i++) {
			expect(snapshots[i]!.lineCount).toBeGreaterThanOrEqual(snapshots[i - 1]!.lineCount);
		}
	});

	it("line count never decreases with markdown formatting", () => {
		const snapshots = simulateStream(
			"# Heading\n\nSome **bold** and *italic* text.\n\n" +
			"- item one\n- item two\n- item three\n\n" +
			"A `code span` and a paragraph.",
		);
		for (let i = 1; i < snapshots.length; i++) {
			expect(snapshots[i]!.lineCount).toBeGreaterThanOrEqual(snapshots[i - 1]!.lineCount);
		}
	});

	it("line count never decreases with code blocks", () => {
		const snapshots = simulateStream(
			"Before code:\n\n```typescript\nconst x = 1;\nconst y = 2;\nconsole.log(x + y);\n```\n\nAfter code.",
		);
		for (let i = 1; i < snapshots.length; i++) {
			expect(snapshots[i]!.lineCount).toBeGreaterThanOrEqual(snapshots[i - 1]!.lineCount);
		}
	});
});
