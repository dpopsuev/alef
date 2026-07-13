import { describe, expect, it, vi } from "vitest";
import { PreviewSelectList } from "../src/components/preview-select-list.js";

const theme = {
	selectedPrefix: (s: string) => s,
	selectedText: (s: string) => s,
	description: (s: string) => s,
	scrollInfo: (s: string) => s,
	noMatch: (s: string) => s,
};

describe("PreviewSelectList history scroll", { tags: ["unit"] }, () => {
	it("pins preview to the end on selection so the recent tail is visible", () => {
		const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
		const list = new PreviewSelectList({
			items: [{ value: "a", label: "A" }],
			maxVisible: 8,
			theme,
			previewFn: () => lines,
			pinPreviewToEnd: true,
		});

		list.render(100);
		// Pin to end: last page of the 20-line preview is visible.
		expect(list.previewScrollOffset).toBeGreaterThan(0);
		expect(list.previewScrollOffset).toBe(Math.max(0, lines.length - 6));
	});

	it("requests more history when scrolling toward the top while preview-focused", () => {
		const needMore = vi.fn();
		let lines = Array.from({ length: 12 }, (_, i) => `line ${i}`);
		const list = new PreviewSelectList({
			items: [{ value: "a", label: "A" }],
			maxVisible: 8,
			theme,
			previewFn: () => lines,
			pinPreviewToEnd: true,
			onPreviewNeedMore: needMore,
		});

		list.render(100);
		list.handleInput("l"); // focus preview
		// scroll to top
		while (list.previewScrollOffset > 0) {
			list.handleInput("k");
		}
		list.handleInput("k"); // attempt past top
		expect(needMore).toHaveBeenCalled();
		expect(needMore.mock.calls[0]?.[0]?.value).toBe("a");
	});

	it("preserves viewport when preview content is prepended", () => {
		let lines = Array.from({ length: 10 }, (_, i) => `line ${i}`);
		const list = new PreviewSelectList({
			items: [{ value: "a", label: "A" }],
			maxVisible: 8,
			theme,
			previewFn: () => lines,
			pinPreviewToEnd: true,
		});

		list.render(100);
		const offsetBefore = list.previewScrollOffset;
		list.handleInput("l");
		// scroll up a bit
		list.handleInput("k");
		list.handleInput("k");
		const midOffset = list.previewScrollOffset;

		// prepend older history
		lines = [...Array.from({ length: 5 }, (_, i) => `old ${i}`), ...lines];
		list.render(100);

		expect(list.previewScrollOffset).toBe(midOffset + 5);
		expect(list.previewScrollOffset).toBeGreaterThan(offsetBefore - 2);
	});

	it("z enters read-only full preview; Enter does not select; Esc exits", () => {
		const onSelect = vi.fn();
		const onReading = vi.fn();
		const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`);
		const list = new PreviewSelectList({
			items: [{ value: "a", label: "Session A" }],
			maxVisible: 8,
			theme,
			previewFn: () => lines,
			pinPreviewToEnd: true,
			onReadingChange: onReading,
			readingMaxVisible: 20,
		});
		list.onSelect = onSelect;

		list.render(100);
		list.handleInput("z");
		expect(list.isReading).toBe(true);
		expect(onReading).toHaveBeenCalledWith(true);

		const readingLines = list.render(80);
		expect(readingLines[0]).toContain("READ-ONLY");
		expect(readingLines[0]).toContain("Session A");
		expect(readingLines.some((l) => l.includes("│"))).toBe(false);

		list.handleInput("\r");
		expect(onSelect).not.toHaveBeenCalled();

		list.handleInput("\x1b");
		expect(list.isReading).toBe(false);
		expect(onReading).toHaveBeenCalledWith(false);
	});

	it("z is a no-op on New session", () => {
		const list = new PreviewSelectList({
			items: [{ value: "__new__", label: "New session" }],
			maxVisible: 8,
			theme,
			previewFn: () => ["fresh"],
		});
		list.handleInput("z");
		expect(list.isReading).toBe(false);
	});
});
