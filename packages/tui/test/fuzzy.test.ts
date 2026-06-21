import assert from "node:assert";
import { describe, it } from "vitest";
import {
	exactMatch,
	extendedFilter,
	fuzzyFilter,
	fuzzyMatch,
	parseSearchTokens,
	prefixMatch,
	regexMatch,
	suffixMatch,
} from "../src/fuzzy.js";

// ---------------------------------------------------------------------------
// fuzzyMatch (subsequence)
// ---------------------------------------------------------------------------

describe("fuzzyMatch", () => {
	it("empty query matches everything with score 0", () => {
		const result = fuzzyMatch("", "anything");
		assert.strictEqual(result.matches, true);
		assert.strictEqual(result.score, 0);
	});

	it("query longer than text does not match", () => {
		const result = fuzzyMatch("longquery", "short");
		assert.strictEqual(result.matches, false);
	});

	it("exact match has good score", () => {
		const result = fuzzyMatch("test", "test");
		assert.strictEqual(result.matches, true);
		assert.ok(result.score < 0);
	});

	it("characters must appear in order", () => {
		assert.strictEqual(fuzzyMatch("abc", "aXbXc").matches, true);
		assert.strictEqual(fuzzyMatch("abc", "cba").matches, false);
	});

	it("case insensitive matching", () => {
		assert.strictEqual(fuzzyMatch("ABC", "abc").matches, true);
		assert.strictEqual(fuzzyMatch("abc", "ABC").matches, true);
	});

	it("consecutive matches score better than scattered matches", () => {
		const consecutive = fuzzyMatch("foo", "foobar");
		const scattered = fuzzyMatch("foo", "f_o_o_bar");
		assert.ok(consecutive.score < scattered.score);
	});

	it("word boundary matches score better", () => {
		const atBoundary = fuzzyMatch("fb", "foo-bar");
		const notAtBoundary = fuzzyMatch("fb", "afbx");
		assert.ok(atBoundary.score < notAtBoundary.score);
	});

	it("matches swapped alpha numeric tokens", () => {
		assert.strictEqual(fuzzyMatch("codex52", "gpt-5.2-codex").matches, true);
	});
});

// ---------------------------------------------------------------------------
// exactMatch (contiguous substring)
// ---------------------------------------------------------------------------

describe("exactMatch", () => {
	it("matches contiguous substring", () => {
		assert.strictEqual(exactMatch("de-ver", "claude-vertex").matches, true);
	});

	it("does not match non-contiguous chars", () => {
		assert.strictEqual(exactMatch("clvtx", "claude-vertex").matches, false);
	});

	it("case insensitive", () => {
		assert.strictEqual(exactMatch("CLAUDE", "claude-vertex").matches, true);
	});

	it("earlier match scores better", () => {
		const early = exactMatch("cl", "claude");
		const late = exactMatch("cl", "xxx-claude");
		assert.ok(early.score < late.score);
	});
});

// ---------------------------------------------------------------------------
// prefixMatch
// ---------------------------------------------------------------------------

describe("prefixMatch", () => {
	it("matches start of string", () => {
		assert.strictEqual(prefixMatch("clau", "claude-vertex").matches, true);
	});

	it("does not match middle", () => {
		assert.strictEqual(prefixMatch("vert", "claude-vertex").matches, false);
	});

	it("case insensitive", () => {
		assert.strictEqual(prefixMatch("CLAU", "claude-vertex").matches, true);
	});
});

// ---------------------------------------------------------------------------
// suffixMatch
// ---------------------------------------------------------------------------

describe("suffixMatch", () => {
	it("matches end of string", () => {
		assert.strictEqual(suffixMatch("vertex", "claude-vertex").matches, true);
	});

	it("does not match start", () => {
		assert.strictEqual(suffixMatch("claude", "claude-vertex").matches, false);
	});

	it("case insensitive", () => {
		assert.strictEqual(suffixMatch("VERTEX", "claude-vertex").matches, true);
	});
});

// ---------------------------------------------------------------------------
// regexMatch
// ---------------------------------------------------------------------------

describe("regexMatch", () => {
	it("matches regex pattern", () => {
		assert.strictEqual(regexMatch("clau.*tex", "claude-vertex").matches, true);
	});

	it("does not match non-matching pattern", () => {
		assert.strictEqual(regexMatch("^vertex", "claude-vertex").matches, false);
	});

	it("handles invalid regex gracefully", () => {
		assert.strictEqual(regexMatch("[invalid", "anything").matches, false);
	});
});

// ---------------------------------------------------------------------------
// parseSearchTokens (fzf syntax)
// ---------------------------------------------------------------------------

describe("parseSearchTokens", () => {
	it("empty input returns empty", () => {
		assert.deepStrictEqual(parseSearchTokens(""), []);
		assert.deepStrictEqual(parseSearchTokens("  "), []);
	});

	it("plain tokens are fuzzy", () => {
		const tokens = parseSearchTokens("clau ver");
		assert.strictEqual(tokens.length, 1);
		assert.strictEqual(tokens[0].length, 2);
		assert.strictEqual(tokens[0][0].strategy, "fuzzy");
		assert.strictEqual(tokens[0][0].query, "clau");
		assert.strictEqual(tokens[0][1].query, "ver");
	});

	it("quoted token is exact", () => {
		const tokens = parseSearchTokens("'exact");
		assert.strictEqual(tokens[0][0].strategy, "exact");
		assert.strictEqual(tokens[0][0].query, "exact");
	});

	it("caret token is prefix", () => {
		const tokens = parseSearchTokens("^prefix");
		assert.strictEqual(tokens[0][0].strategy, "prefix");
		assert.strictEqual(tokens[0][0].query, "prefix");
	});

	it("dollar token is suffix", () => {
		const tokens = parseSearchTokens("suffix$");
		assert.strictEqual(tokens[0][0].strategy, "suffix");
		assert.strictEqual(tokens[0][0].query, "suffix");
	});

	it("slash-wrapped token is regex", () => {
		const tokens = parseSearchTokens("/pat.*tern/");
		assert.strictEqual(tokens[0][0].strategy, "regex");
		assert.strictEqual(tokens[0][0].query, "pat.*tern");
	});

	it("bang prefix is inverse", () => {
		const tokens = parseSearchTokens("!excluded");
		assert.strictEqual(tokens[0][0].inverse, true);
		assert.strictEqual(tokens[0][0].strategy, "fuzzy");
		assert.strictEqual(tokens[0][0].query, "excluded");
	});

	it("bang + caret is inverse prefix", () => {
		const tokens = parseSearchTokens("!^test");
		assert.strictEqual(tokens[0][0].inverse, true);
		assert.strictEqual(tokens[0][0].strategy, "prefix");
	});

	it("pipe creates OR groups", () => {
		const tokens = parseSearchTokens("claude | gemini");
		assert.strictEqual(tokens.length, 2);
		assert.strictEqual(tokens[0][0].query, "claude");
		assert.strictEqual(tokens[1][0].query, "gemini");
	});

	it("complex query: ^claude vertex$ | gemini !haiku", () => {
		const tokens = parseSearchTokens("^claude vertex$ | gemini !haiku");
		assert.strictEqual(tokens.length, 2);
		assert.strictEqual(tokens[0][0].strategy, "prefix");
		assert.strictEqual(tokens[0][0].query, "claude");
		assert.strictEqual(tokens[0][1].strategy, "suffix");
		assert.strictEqual(tokens[0][1].query, "vertex");
		assert.strictEqual(tokens[1][0].strategy, "fuzzy");
		assert.strictEqual(tokens[1][0].query, "gemini");
		assert.strictEqual(tokens[1][1].inverse, true);
		assert.strictEqual(tokens[1][1].query, "haiku");
	});
});

// ---------------------------------------------------------------------------
// extendedFilter (fzf-style full search)
// ---------------------------------------------------------------------------

describe("extendedFilter", () => {
	const models = [
		"anthropic/claude-sonnet-4-5",
		"anthropic/claude-haiku-4-5",
		"google/gemini-2.5-pro",
		"google-vertex/claude-sonnet-4-5",
		"openai/gpt-4o",
		"mistral/mistral-large",
		"deepseek/deepseek-r1",
	];
	const id = (x: string) => x;

	it("plain fuzzy: 'clau ver' matches claude on vertex", () => {
		const result = extendedFilter(models, "clau ver", id);
		assert.ok(result.includes("google-vertex/claude-sonnet-4-5"));
	});

	it("plain fuzzy: 'lau er' matches claude on vertex (subsequence)", () => {
		const result = extendedFilter(models, "lau er", id);
		assert.ok(result.includes("google-vertex/claude-sonnet-4-5"));
	});

	it("unordered: 'vertex claude' matches same as 'claude vertex'", () => {
		const r1 = extendedFilter(models, "claude vertex", id);
		const r2 = extendedFilter(models, "vertex claude", id);
		assert.deepStrictEqual(r1, r2);
	});

	it("exact: 'claude matches contiguous only", () => {
		const result = extendedFilter(models, "'claude-son", id);
		assert.ok(result.includes("anthropic/claude-sonnet-4-5"));
		assert.ok(!result.includes("openai/gpt-4o"));
	});

	it("prefix: ^anthropic", () => {
		const result = extendedFilter(models, "^anthropic", id);
		assert.strictEqual(result.length, 2);
		assert.ok(result.every((r) => r.startsWith("anthropic")));
	});

	it("suffix: 4-5$", () => {
		const result = extendedFilter(models, "haiku 4-5$", id);
		assert.deepStrictEqual(result, ["anthropic/claude-haiku-4-5"]);
	});

	it("inverse: !haiku excludes haiku", () => {
		const result = extendedFilter(models, "claude !haiku", id);
		assert.ok(result.includes("anthropic/claude-sonnet-4-5"));
		assert.ok(!result.includes("anthropic/claude-haiku-4-5"));
	});

	it("OR: claude | gemini", () => {
		const result = extendedFilter(models, "claude | gemini", id);
		assert.ok(result.includes("anthropic/claude-sonnet-4-5"));
		assert.ok(result.includes("google/gemini-2.5-pro"));
		assert.ok(!result.includes("openai/gpt-4o"));
	});

	it("regex: /deep.*r1/", () => {
		const result = extendedFilter(models, "/deep.*r1/", id);
		assert.deepStrictEqual(result, ["deepseek/deepseek-r1"]);
	});

	it("empty query returns all", () => {
		assert.deepStrictEqual(extendedFilter(models, "", id), models);
	});
});

// ---------------------------------------------------------------------------
// fuzzyFilter (backward compat)
// ---------------------------------------------------------------------------

describe("fuzzyFilter", () => {
	it("empty query returns all items unchanged", () => {
		const items = ["apple", "banana", "cherry"];
		assert.deepStrictEqual(
			fuzzyFilter(items, "", (x: string) => x),
			items,
		);
	});

	it("filters out non-matching items", () => {
		const result = fuzzyFilter(["apple", "banana", "cherry"], "an", (x: string) => x);
		assert.ok(result.includes("banana"));
		assert.ok(!result.includes("apple"));
	});

	it("sorts results by match quality", () => {
		const result = fuzzyFilter(["a_p_p", "app", "application"], "app", (x: string) => x);
		assert.strictEqual(result[0], "app");
	});

	it("multi-token: all tokens must match", () => {
		const items = ["claude-vertex", "claude-haiku", "gemini-pro"];
		const result = fuzzyFilter(items, "clau ver", (x: string) => x);
		assert.deepStrictEqual(result, ["claude-vertex"]);
	});
});
