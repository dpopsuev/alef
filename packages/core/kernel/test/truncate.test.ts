import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead, truncateLine, truncateTail } from "../src/truncate.js";

describe("truncateHead", { tags: ["unit"] }, () => {
	it("returns content unchanged when within limits", () => {
		const r = truncateHead("hello\nworld");
		expect(r.truncated).toBe(false);
		expect(r.content).toBe("hello\nworld");
		expect(r.truncatedBy).toBeNull();
	});

	it("truncates by line limit", () => {
		const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
		const r = truncateHead(lines, { maxLines: 5 });
		expect(r.truncated).toBe(true);
		expect(r.truncatedBy).toBe("lines");
		expect(r.outputLines).toBe(5);
		expect(r.content.split("\n")).toHaveLength(5);
	});

	it("truncates by byte limit", () => {
		const content = "x".repeat(200);
		const r = truncateHead(content, { maxBytes: 100 });
		expect(r.truncated).toBe(true);
		expect(r.truncatedBy).toBe("bytes");
		expect(r.outputBytes).toBeLessThanOrEqual(100);
	});

	it("returns empty when first line exceeds byte limit", () => {
		const r = truncateHead("x".repeat(200), { maxBytes: 10, maxLines: 9999 });
		expect(r.firstLineExceedsLimit).toBe(true);
		expect(r.content).toBe("");
	});

	it("exposes totalLines and totalBytes on truncated result", () => {
		const content = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
		const r = truncateHead(content, { maxLines: 5 });
		expect(r.totalLines).toBe(100);
		expect(r.totalBytes).toBeGreaterThan(0);
	});
});

describe("truncateTail", { tags: ["unit"] }, () => {
	it("returns content unchanged when within limits", () => {
		const r = truncateTail("hello\nworld");
		expect(r.truncated).toBe(false);
		expect(r.content).toBe("hello\nworld");
	});

	it("keeps last N lines when truncated by line limit", () => {
		const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
		const r = truncateTail(lines, { maxLines: 5 });
		expect(r.truncated).toBe(true);
		expect(r.outputLines).toBe(5);
		const kept = r.content.split("\n");
		expect(kept[0]).toBe("line 15");
		expect(kept[4]).toBe("line 19");
	});

	it("keeps the tail when truncated by byte limit", () => {
		const content = `${"a".repeat(50)}\n${"b".repeat(50)}`;
		const r = truncateTail(content, { maxBytes: 60 });
		expect(r.truncated).toBe(true);
		expect(r.content).toContain("b");
	});

	it("handles single line exceeding byte limit (partial tail)", () => {
		const r = truncateTail("x".repeat(200), { maxBytes: 50, maxLines: 9999 });
		expect(r.truncated).toBe(true);
		expect(r.lastLinePartial).toBe(true);
		expect(r.outputBytes).toBeLessThanOrEqual(50);
	});
});

describe("truncateLine", { tags: ["unit"] }, () => {
	it("passes short lines through", () => {
		const r = truncateLine("hello");
		expect(r.text).toBe("hello");
		expect(r.wasTruncated).toBe(false);
	});

	it("truncates long lines with marker", () => {
		const r = truncateLine("x".repeat(600));
		expect(r.wasTruncated).toBe(true);
		expect(r.text).toContain("... [truncated]");
	});
});

describe("defaults", { tags: ["unit"] }, () => {
	it("DEFAULT_MAX_LINES is 2000", () => expect(DEFAULT_MAX_LINES).toBe(2000));
	it("DEFAULT_MAX_BYTES is 50KB", () => expect(DEFAULT_MAX_BYTES).toBe(50 * 1024));
});
