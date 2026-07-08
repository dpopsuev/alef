import { describe, expect, it } from "vitest";
import { applyHashlineEdits, fileHash, formatHashline, lineHash, parseHashlineEdits } from "../src/hashline.js";

const SAMPLE = 'function hello() {\n  return "world";\n}';

describe("lineHash", { tags: ["unit"] }, () => {
	it("produces 4-char uppercase hex", () => {
		const hash = lineHash("function hello() {");
		expect(hash).toMatch(/^[0-9A-F]{4}$/);
	});

	it("is deterministic", () => {
		expect(lineHash("foo")).toBe(lineHash("foo"));
	});

	it("ignores trailing whitespace", () => {
		expect(lineHash("foo")).toBe(lineHash("foo   "));
		expect(lineHash("foo")).toBe(lineHash("foo\t"));
	});

	it("different content produces different hash", () => {
		expect(lineHash("foo")).not.toBe(lineHash("bar"));
	});
});

describe("fileHash", { tags: ["unit"] }, () => {
	it("produces 8-char uppercase hex", () => {
		const hash = fileHash(SAMPLE);
		expect(hash).toMatch(/^[0-9A-F]{8}$/);
	});

	it("is deterministic", () => {
		expect(fileHash(SAMPLE)).toBe(fileHash(SAMPLE));
	});
});

describe("formatHashline", { tags: ["unit"] }, () => {
	it("formats with line numbers and hashes", () => {
		const result = formatHashline(SAMPLE);
		const lines = result.split("\n");
		expect(lines[0]).toMatch(/^\[#[0-9A-F]{8}\]$/);
		expect(lines[1]).toMatch(/^1:[0-9A-F]{4}\|function hello\(\) \{$/);
		expect(lines[2]).toMatch(/^2:[0-9A-F]{4}\| {2}return "world";$/);
		expect(lines[3]).toMatch(/^3:[0-9A-F]{4}\|}$/);
	});

	it("respects offset parameter", () => {
		const result = formatHashline("a\nb", 10);
		const lines = result.split("\n");
		expect(lines[1]).toMatch(/^10:/);
		expect(lines[2]).toMatch(/^11:/);
	});
});

describe("parseHashlineEdits", { tags: ["unit"] }, () => {
	it("parses SWAP single line", () => {
		const edits = parseHashlineEdits('SWAP 2\n+  return "universe";');
		expect(edits).toHaveLength(1);
		expect(edits[0]!.kind).toBe("swap");
		expect(edits[0]!.startLine).toBe(2);
		expect(edits[0]!.endLine).toBe(2);
		expect(edits[0]!.body).toEqual(['  return "universe";']);
	});

	it("parses SWAP range", () => {
		const edits = parseHashlineEdits('SWAP 2.=3\n+  return "universe";\n+  // done');
		expect(edits).toHaveLength(1);
		expect(edits[0]!.startLine).toBe(2);
		expect(edits[0]!.endLine).toBe(3);
		expect(edits[0]!.body).toHaveLength(2);
	});

	it("parses DEL", () => {
		const edits = parseHashlineEdits("DEL 5.=8");
		expect(edits).toHaveLength(1);
		expect(edits[0]!.kind).toBe("del");
		expect(edits[0]!.startLine).toBe(5);
		expect(edits[0]!.endLine).toBe(8);
	});

	it("parses INS.POST", () => {
		const edits = parseHashlineEdits("INS.POST 3\n+// new line");
		expect(edits).toHaveLength(1);
		expect(edits[0]!.kind).toBe("ins_post");
		expect(edits[0]!.startLine).toBe(3);
		expect(edits[0]!.body).toEqual(["// new line"]);
	});

	it("parses INS.PRE", () => {
		const edits = parseHashlineEdits("INS.PRE 1\n+// header");
		expect(edits).toHaveLength(1);
		expect(edits[0]!.kind).toBe("ins_pre");
	});

	it("parses multiple edits", () => {
		const input = "SWAP 2\n+new line 2\n\nDEL 5\n\nINS.POST 10\n+added";
		const edits = parseHashlineEdits(input);
		expect(edits).toHaveLength(3);
	});
});

describe("applyHashlineEdits", { tags: ["unit"] }, () => {
	it("SWAP replaces a line", () => {
		const { result } = applyHashlineEdits(SAMPLE, [
			{ kind: "swap", startLine: 2, endLine: 2, body: ['  return "universe";'] },
		]);
		expect(result).toContain("universe");
		expect(result).not.toContain("world");
	});

	it("DEL removes lines", () => {
		const content = "a\nb\nc\nd";
		const { result } = applyHashlineEdits(content, [{ kind: "del", startLine: 2, endLine: 3, body: [] }]);
		expect(result).toBe("a\nd");
	});

	it("INS.POST inserts after line", () => {
		const content = "a\nb\nc";
		const { result } = applyHashlineEdits(content, [
			{ kind: "ins_post", startLine: 2, endLine: 2, body: ["inserted"] },
		]);
		expect(result).toBe("a\nb\ninserted\nc");
	});

	it("INS.PRE inserts before line", () => {
		const content = "a\nb\nc";
		const { result } = applyHashlineEdits(content, [
			{ kind: "ins_pre", startLine: 2, endLine: 2, body: ["inserted"] },
		]);
		expect(result).toBe("a\ninserted\nb\nc");
	});

	it("rejects stale file hash", () => {
		const { error } = applyHashlineEdits(SAMPLE, [], "DEADBEEF");
		expect(error).toContain("File changed since last read");
	});

	it("accepts matching file hash", () => {
		const hash = fileHash(SAMPLE);
		const { result, error } = applyHashlineEdits(
			SAMPLE,
			[{ kind: "swap", startLine: 2, endLine: 2, body: ['  return "ok";'] }],
			hash,
		);
		expect(error).toBeUndefined();
		expect(result).toContain("ok");
	});

	it("rejects out-of-bounds line", () => {
		const { error } = applyHashlineEdits("a\nb", [{ kind: "del", startLine: 5, endLine: 5, body: [] }]);
		expect(error).toContain("out of bounds");
	});

	it("multiple edits applied in reverse order", () => {
		const content = "a\nb\nc\nd";
		const { result } = applyHashlineEdits(content, [
			{ kind: "swap", startLine: 2, endLine: 2, body: ["B"] },
			{ kind: "swap", startLine: 4, endLine: 4, body: ["D"] },
		]);
		expect(result).toBe("a\nB\nc\nD");
	});
});
