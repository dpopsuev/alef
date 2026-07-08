/**
 * Web search integration tests — real API calls.
 * Skipped unless at least one search API key is set.
 */

import {
	BraveSearchEngine,
	DdgSearchEngine,
	defaultSearchEngine,
	ExaSearchEngine,
	TavilySearchEngine,
} from "@dpopsuev/web-spider";
import { describe, expect, it } from "vitest";

const BRAVE_KEY = process.env.BRAVE_SEARCH_API_KEY;
const TAVILY_KEY = process.env.TAVILY_API_KEY;
const EXA_KEY = process.env.EXA_API_KEY;

const hasAnyKey = BRAVE_KEY || TAVILY_KEY || EXA_KEY;
const _skipMessage = "No search API keys set. Set BRAVE_SEARCH_API_KEY, TAVILY_API_KEY, or EXA_API_KEY to enable.";

describe.skipIf(!BRAVE_KEY)("BraveSearchEngine integration", { tags: ["integration"] }, () => {
	it("returns results for a simple query", async () => {
		const engine = new BraveSearchEngine(BRAVE_KEY!);
		const results = await engine.search({ query: "TypeScript programming language", numResults: 5 });

		expect(results.length).toBeGreaterThan(0);
		expect(results[0]!).toHaveProperty("url");
		expect(results[0]!).toHaveProperty("title");
		expect(results[0]!).toHaveProperty("snippet");
		expect(results[0]!.url).toMatch(/^https?:\/\//);
	}, 30_000);
});

describe.skipIf(!TAVILY_KEY)("TavilySearchEngine integration", { tags: ["integration"] }, () => {
	it("returns results for a simple query", async () => {
		const engine = new TavilySearchEngine(TAVILY_KEY!);
		const results = await engine.search({ query: "TypeScript programming language", numResults: 5 });

		expect(results.length).toBeGreaterThan(0);
		expect(results[0]!).toHaveProperty("url");
		expect(results[0]!).toHaveProperty("title");
		expect(results[0]!).toHaveProperty("snippet");
		expect(results[0]!.url).toMatch(/^https?:\/\//);
	}, 30_000);
});

describe.skipIf(!EXA_KEY)("ExaSearchEngine integration", { tags: ["integration"] }, () => {
	it("returns results for a simple query", async () => {
		const engine = new ExaSearchEngine(EXA_KEY!);
		const results = await engine.search({ query: "TypeScript programming language", numResults: 5 });

		expect(results.length).toBeGreaterThan(0);
		expect(results[0]!).toHaveProperty("url");
		expect(results[0]!).toHaveProperty("title");
		expect(results[0]!).toHaveProperty("snippet");
		expect(results[0]!.url).toMatch(/^https?:\/\//);
	}, 30_000);
});

describe("DdgSearchEngine integration (free, always enabled)", { tags: ["integration"] }, () => {
	it("returns results for a simple query", async () => {
		const engine = new DdgSearchEngine();
		const results = await engine.search({ query: "TypeScript programming language", numResults: 5 });

		// DDG's free API is best-effort; it may return 0 results for some queries.
		// We just verify it doesn't throw and returns the correct structure.
		expect(Array.isArray(results)).toBe(true);
		if (results.length > 0) {
			expect(results[0]!).toHaveProperty("url");
			expect(results[0]!).toHaveProperty("title");
			expect(results[0]!).toHaveProperty("snippet");
			expect(results[0]!.url).toMatch(/^https?:\/\//);
		}
	}, 30_000);
});

describe.skipIf(!hasAnyKey)("defaultSearchEngine fallback", { tags: ["integration"] }, () => {
	it("returns results using fallback chain", async () => {
		const engine = defaultSearchEngine();
		const results = await engine.search({ query: "TypeScript programming language", numResults: 5 });

		expect(results.length).toBeGreaterThan(0);
		expect(results[0]!).toHaveProperty("url");
		expect(results[0]!).toHaveProperty("title");
		expect(results[0]!).toHaveProperty("snippet");
		expect(results[0]!.url).toMatch(/^https?:\/\//);
	}, 30_000);
});

describe("defaultSearchEngine fallback (no keys, DDG only)", { tags: ["integration"] }, () => {
	it("falls back to DDG when no API keys are set", async () => {
		// Temporarily clear env vars.
		const originalBrave = process.env.BRAVE_SEARCH_API_KEY;
		const originalTavily = process.env.TAVILY_API_KEY;
		const originalExa = process.env.EXA_API_KEY;

		delete process.env.BRAVE_SEARCH_API_KEY;
		delete process.env.TAVILY_API_KEY;
		delete process.env.EXA_API_KEY;

		try {
			const engine = defaultSearchEngine();
			const results = await engine.search({ query: "TypeScript programming language", numResults: 5 });

			// Should not throw; returns DDG results (may be empty).
			expect(Array.isArray(results)).toBe(true);
		} finally {
			// Restore env vars.
			if (originalBrave) process.env.BRAVE_SEARCH_API_KEY = originalBrave;
			if (originalTavily) process.env.TAVILY_API_KEY = originalTavily;
			if (originalExa) process.env.EXA_API_KEY = originalExa;
		}
	}, 30_000);
});
