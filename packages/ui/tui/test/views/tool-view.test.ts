/**
 * Unit tests for tool-view.ts — tool line formatting and output rendering.
 */

import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import {
	formatTokenUsage,
	formatToolArgs,
	keyArgFromPayload,
	largeTextArgPreview,
	renderDiffDisplay,
	renderToolLine,
	stripMarkdownFenceLines,
	truncateToolOutput,
} from "../../src/views/index.js";

const W = { ansi16: 37 };
const OK = { ansi16: 32 };
const ERR = { ansi16: 31 };
const WARN = { ansi16: 33 };
function getTheme() {
	return {
		userFg: W,
		userBg: W,
		agentFg: W,
		agentBg: W,
		primaryFg: W,
		secondaryFg: W,
		mutedFg: W,
		accentFg: W,
		brightFg: W,
		okFg: OK,
		warnFg: WARN,
		errFg: ERR,
	};
}

describe("keyArgFromPayload", { tags: ["unit"] }, () => {
	it("extracts path", () => expect(keyArgFromPayload({ path: "src/foo.ts" })).toBe("src/foo.ts"));
	it("extracts command", () => expect(keyArgFromPayload({ command: "ls -la" })).toBe("ls -la"));
	it("truncates to 80 chars", () => {
		const long = "a".repeat(100);
		expect(keyArgFromPayload({ path: long }).length).toBe(80);
	});
	it("returns empty string when no known key", () => expect(keyArgFromPayload({ foo: "bar" })).toBe(""));
});

describe("truncateToolOutput", { tags: ["unit"] }, () => {
	it("passes through short text unchanged", () => {
		expect(truncateToolOutput("hello")).toBe("hello");
	});

	it("caps at 20 lines", () => {
		const input = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
		const out = truncateToolOutput(input);
		const lines = out.split("\n");
		expect(lines.length).toBeLessThanOrEqual(22); // 20 content + ellipsis note
		expect(out).toContain("more lines");
	});

	it("caps at 1000 chars", () => {
		const input = "x".repeat(2000);
		const out = truncateToolOutput(input);
		expect(out.length).toBeLessThanOrEqual(1010);
	});
});

describe("renderToolLine", { tags: ["unit"] }, () => {
	it("contains tool name", () => {
		const line = stripVTControlCharacters(renderToolLine("fs.read", "foo.ts", 42, true, getTheme()));
		expect(line).toContain("fs.read");
	});

	it("contains elapsed time", () => {
		const ms = stripVTControlCharacters(renderToolLine("fs.read", "", 500, true, getTheme()));
		expect(ms).toContain("500ms");
		const sec = stripVTControlCharacters(renderToolLine("fs.read", "", 1500, true, getTheme()));
		expect(sec).toContain("1.5s");
	});
});

describe("renderDiffDisplay", { tags: ["unit"] }, () => {
	it("header line is Edited path with +/- stats", () => {
		const diff = "edit src/foo.ts\n+1 new\n-1 old";
		const out = renderDiffDisplay(diff, getTheme());
		expect(stripVTControlCharacters(out.split("\n")[0]!)).toBe("Edited src/foo.ts +1 -1");
	});

	it("added lines are green", () => {
		const out = renderDiffDisplay("edit x\n+1 new line", getTheme());
		expect(out).toMatch(/\x1b\[32m/);
	});

	it("removed lines are red", () => {
		const out = renderDiffDisplay("edit x\n-1 old line", getTheme());
		expect(out).toMatch(/\x1b\[31m/);
	});
});

describe("formatToolArgs", { tags: ["unit"] }, () => {
	it("returns empty string for no args", () => {
		expect(formatToolArgs({})).toBe("");
	});

	it("formats scalars in command-style syntax", () => {
		expect(formatToolArgs({ path: "README.md", limit: 10, force: true })).toBe(
			"(path: 'README.md', limit: 10, force: true)",
		);
	});

	it("summarizes arrays and objects", () => {
		expect(formatToolArgs({ files: ["a", "b"], meta: { a: 1 } })).toBe("(files: [2 items], meta: {…})");
	});

	it("summarizes multi-line content instead of inlining", () => {
		const content = "line1\nline2\nline3";
		expect(formatToolArgs({ path: "schema.sql", content })).toBe(
			"(path: 'schema.sql', content: <3 lines, 17 chars>)",
		);
	});
});

describe("stripMarkdownFenceLines", { tags: ["unit"] }, () => {
	it("removes outer fence marker lines", () => {
		const out = stripMarkdownFenceLines("```\nhello\n```");
		expect(out).toBe("hello");
		expect(out).not.toContain("```");
	});
});

describe("largeTextArgPreview", { tags: ["unit"] }, () => {
	it("extracts path and sql body for fs.write-style args", () => {
		const preview = largeTextArgPreview({
			path: "/tmp/schema.sql",
			content: "CREATE TABLE t (\n  id INT\n);",
		});
		expect(preview?.lang).toBe("sql");
		expect(preview?.header).toContain("schema.sql");
		expect(preview?.body).toContain("CREATE TABLE");
	});
});

describe("formatTokenUsage", { tags: ["unit"] }, () => {
	it("formats small numbers", () => {
		const s = stripVTControlCharacters(formatTokenUsage(7, 100, getTheme()));
		expect(s).toContain("7");
		expect(s).toContain("100");
	});

	it("formats large numbers with suffix", () => {
		const s = stripVTControlCharacters(formatTokenUsage(1500, 2_000_000, getTheme()));
		expect(s).toContain("1.5k");
		expect(s).toContain("2.0M");
	});
});
