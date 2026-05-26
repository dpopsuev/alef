/**
 * Search engine tests — no real network calls.
 * Uses mock engines to validate fallback behavior and registry.
 */

import { describe, expect, it } from "vitest";
import { FallbackSearchEngine, registerSearchEngine, resolveSearchEngine } from "../src/search-engines.js";
import type { ISearchEngine, SearchQuery, WebSearchResult } from "../src/search-ports.js";

/** Mock search engine that returns fixed results. */
class MockSearchEngine implements ISearchEngine {
	constructor(
		private readonly results: WebSearchResult[],
		private readonly shouldThrow = false,
	) {}

	async search(_req: SearchQuery): Promise<WebSearchResult[]> {
		if (this.shouldThrow) throw new Error("Mock search engine error");
		return this.results;
	}
}

describe("FallbackSearchEngine", () => {
	it("returns results from first engine", async () => {
		const engine1 = new MockSearchEngine([
			{ url: "https://example.com/1", title: "Result 1", snippet: "First result" },
		]);
		const engine2 = new MockSearchEngine([
			{ url: "https://example.com/2", title: "Result 2", snippet: "Second result" },
		]);

		const fallback = new FallbackSearchEngine([engine1, engine2]);
		const results = await fallback.search({ query: "test" });

		expect(results).toHaveLength(1);
		expect(results[0].url).toBe("https://example.com/1");
	});

	it("falls back to second engine when first returns empty", async () => {
		const engine1 = new MockSearchEngine([]);
		const engine2 = new MockSearchEngine([
			{ url: "https://example.com/2", title: "Result 2", snippet: "Second result" },
		]);

		const fallback = new FallbackSearchEngine([engine1, engine2]);
		const results = await fallback.search({ query: "test" });

		expect(results).toHaveLength(1);
		expect(results[0].url).toBe("https://example.com/2");
	});

	it("falls back to second engine when first throws", async () => {
		const engine1 = new MockSearchEngine([], true);
		const engine2 = new MockSearchEngine([
			{ url: "https://example.com/2", title: "Result 2", snippet: "Second result" },
		]);

		const fallback = new FallbackSearchEngine([engine1, engine2]);
		const results = await fallback.search({ query: "test" });

		expect(results).toHaveLength(1);
		expect(results[0].url).toBe("https://example.com/2");
	});

	it("returns empty when all engines return empty and fallbackOnEmpty=true", async () => {
		const engine1 = new MockSearchEngine([]);
		const engine2 = new MockSearchEngine([]);

		const fallback = new FallbackSearchEngine([engine1, engine2]);
		const results = await fallback.search({ query: "test" });

		expect(results).toHaveLength(0);
	});

	it("returns first engine's empty result when fallbackOnEmpty=false", async () => {
		const engine1 = new MockSearchEngine([]);
		const engine2 = new MockSearchEngine([
			{ url: "https://example.com/2", title: "Result 2", snippet: "Second result" },
		]);

		const fallback = new FallbackSearchEngine([engine1, engine2], { fallbackOnEmpty: false });
		const results = await fallback.search({ query: "test" });

		expect(results).toHaveLength(0);
	});

	it("throws error from first engine when fallbackOnError=false", async () => {
		const engine1 = new MockSearchEngine([], true);
		const engine2 = new MockSearchEngine([
			{ url: "https://example.com/2", title: "Result 2", snippet: "Second result" },
		]);

		const fallback = new FallbackSearchEngine([engine1, engine2], { fallbackOnError: false });

		await expect(fallback.search({ query: "test" })).rejects.toThrow("Mock search engine error");
	});

	it("throws last error when all engines throw", async () => {
		const engine1 = new MockSearchEngine([], true);
		const engine2 = new MockSearchEngine([], true);

		const fallback = new FallbackSearchEngine([engine1, engine2]);

		await expect(fallback.search({ query: "test" })).rejects.toThrow("Mock search engine error");
	});

	it("throws when constructed with no engines", () => {
		expect(() => new FallbackSearchEngine([])).toThrow("requires at least one engine");
	});
});

describe("Search engine registry", () => {
	it("registers and resolves custom engine", () => {
		const mockResults = [{ url: "https://example.com", title: "Test", snippet: "Test result" }];
		registerSearchEngine("test-engine", () => new MockSearchEngine(mockResults));

		const engine = resolveSearchEngine("test-engine");
		expect(engine).toBeDefined();
	});

	it("throws for unknown engine name", () => {
		expect(() => resolveSearchEngine("nonexistent-engine-xyz")).toThrow("Unknown search engine");
	});

	it("built-in engines are registered", () => {
		// These should not throw (though they may fail if API keys are missing).
		expect(() => resolveSearchEngine("ddg")).not.toThrow();
	});
});
