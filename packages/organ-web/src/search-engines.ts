/**
 * Web search API integration — Brave Search, Tavily, Exa, and DuckDuckGo.
 *
 * All return a normalised WebSearchResult[].
 * API keys are read from environment variables by default:
 *   BRAVE_SEARCH_API_KEY
 *   TAVILY_API_KEY
 *   EXA_API_KEY
 *   (DuckDuckGo requires no key)
 */

import type { ISearchEngine, SearchQuery, WebSearchResult } from "./search-ports.js";

// ---------------------------------------------------------------------------
// Brave Search
// ---------------------------------------------------------------------------

export interface BraveSearchOptions {
	/** API key. Defaults to process.env.BRAVE_SEARCH_API_KEY. */
	apiKey?: string;
	/** Number of results (1–20). Default 10. */
	numResults?: number;
	/** ISO 3166-1 alpha-2 country code for localised results, e.g. "US". */
	country?: string;
}

/**
 * Search the web via the Brave Search API.
 * https://brave.com/search/api/
 */
export async function braveSearch(query: string, opts: BraveSearchOptions = {}): Promise<WebSearchResult[]> {
	const apiKey = opts.apiKey ?? process.env.BRAVE_SEARCH_API_KEY;
	if (!apiKey) throw new Error("Brave API key required — set BRAVE_SEARCH_API_KEY or pass opts.apiKey");

	const url = new URL("https://api.search.brave.com/res/v1/web/search");
	url.searchParams.set("q", query);
	url.searchParams.set("count", String(opts.numResults ?? 10));
	if (opts.country) url.searchParams.set("country", opts.country);

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 15_000);
	let res: Response;
	try {
		res = await fetch(url.toString(), {
			signal: controller.signal,
			headers: {
				Accept: "application/json",
				"X-Subscription-Token": apiKey,
			},
		});
	} finally {
		clearTimeout(timer);
	}

	if (!res.ok) throw new Error(`Brave API error: ${res.status} ${res.statusText}`);

	const data = (await res.json()) as {
		web?: {
			results?: Array<{
				url: string;
				title: string;
				description: string;
				age?: string;
			}>;
		};
	};

	return (data.web?.results ?? []).map((r) => ({
		url: r.url,
		title: r.title,
		snippet: r.description,
		...(r.age ? { publishedAt: r.age } : {}),
	}));
}

// ---------------------------------------------------------------------------
// Tavily Search
// ---------------------------------------------------------------------------

export interface TavilySearchOptions {
	/** API key. Defaults to process.env.TAVILY_API_KEY. */
	apiKey?: string;
	/** Number of results. Default 5. */
	numResults?: number;
	/** "basic" (1 credit) or "advanced" (2 credits). Default "basic". */
	depth?: "basic" | "advanced";
}

/**
 * Search the web via the Tavily Search API.
 * https://tavily.com/
 */
export async function tavilySearch(query: string, opts: TavilySearchOptions = {}): Promise<WebSearchResult[]> {
	const apiKey = opts.apiKey ?? process.env.TAVILY_API_KEY;
	if (!apiKey) throw new Error("Tavily API key required — set TAVILY_API_KEY or pass opts.apiKey");

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 15_000);
	let res: Response;
	try {
		res = await fetch("https://api.tavily.com/search", {
			method: "POST",
			signal: controller.signal,
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				api_key: apiKey,
				query,
				max_results: opts.numResults ?? 5,
				search_depth: opts.depth ?? "basic",
			}),
		});
	} finally {
		clearTimeout(timer);
	}

	if (!res.ok) throw new Error(`Tavily API error: ${res.status} ${res.statusText}`);

	const data = (await res.json()) as {
		results?: Array<{
			url: string;
			title: string;
			content: string;
			published_date?: string;
		}>;
	};

	return (data.results ?? []).map((r) => ({
		url: r.url,
		title: r.title,
		snippet: r.content,
		...(r.published_date ? { publishedAt: r.published_date } : {}),
	}));
}

// ---------------------------------------------------------------------------
// Exa Search
// ---------------------------------------------------------------------------

export interface ExaSearchOptions {
	/** API key. Defaults to process.env.EXA_API_KEY. */
	apiKey?: string;
	/** Number of results. Default 10. */
	numResults?: number;
	/**
	 * Search type.
	 * "auto"   — Exa decides keyword vs neural (default).
	 * "neural" — embedding-based semantic search.
	 * "keyword" — traditional keyword search.
	 */
	type?: "auto" | "neural" | "keyword";
}

/**
 * Search the web via the Exa Search API (neural/semantic retrieval).
 * https://exa.ai/docs/reference/search
 *
 * Returns highlights inline per result — richer snippets without extra round-trips.
 */
export async function exaSearch(query: string, opts: ExaSearchOptions = {}): Promise<WebSearchResult[]> {
	const apiKey = opts.apiKey ?? process.env.EXA_API_KEY;
	if (!apiKey) throw new Error("Exa API key required — set EXA_API_KEY or pass opts.apiKey");

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 15_000);
	let res: Response;
	try {
		res = await fetch("https://api.exa.ai/search", {
			method: "POST",
			signal: controller.signal,
			headers: {
				"Content-Type": "application/json",
				"x-api-key": apiKey,
			},
			body: JSON.stringify({
				query,
				numResults: opts.numResults ?? 10,
				type: opts.type ?? "auto",
				contents: {
					highlights: { numSentences: 2, highlightsPerUrl: 3 },
				},
			}),
		});
	} finally {
		clearTimeout(timer);
	}

	if (!res.ok) throw new Error(`Exa API error: ${res.status} ${res.statusText}`);

	const data = (await res.json()) as {
		results?: Array<{
			url: string;
			title: string;
			publishedDate?: string;
			highlights?: string[];
		}>;
	};

	return (data.results ?? []).map((r) => ({
		url: r.url,
		title: r.title,
		snippet: r.highlights?.join(" … ") ?? "",
		...(r.publishedDate ? { publishedAt: r.publishedDate } : {}),
	}));
}

// ---------------------------------------------------------------------------
// DuckDuckGo Instant Answer
// ---------------------------------------------------------------------------

export interface DdgSearchOptions {
	/** Number of results. Default 10. */
	numResults?: number;
}

/**
 * Search the web via DuckDuckGo Instant Answer API (free, no API key).
 * https://duckduckgo.com/api
 *
 * Note: This is a best-effort adapter. DDG's free API is limited and may
 * return fewer results than requested or none at all for some queries.
 */
export async function ddgSearch(query: string, opts: DdgSearchOptions = {}): Promise<WebSearchResult[]> {
	const url = new URL("https://api.duckduckgo.com/");
	url.searchParams.set("q", query);
	url.searchParams.set("format", "json");
	url.searchParams.set("no_html", "1");
	url.searchParams.set("skip_disambig", "1");

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 15_000);
	let res: Response;
	try {
		res = await fetch(url.toString(), {
			signal: controller.signal,
			headers: {
				"User-Agent": "Alef/1.0 (agent; +https://github.com/dpopsuev/alef)",
			},
		});
	} finally {
		clearTimeout(timer);
	}

	if (!res.ok) throw new Error(`DDG API error: ${res.status} ${res.statusText}`);

	const data = (await res.json()) as {
		AbstractText?: string;
		AbstractURL?: string;
		RelatedTopics?: Array<{
			FirstURL?: string;
			Text?: string;
		}>;
	};

	const results: WebSearchResult[] = [];

	// Add the abstract if available.
	if (data.AbstractText && data.AbstractURL) {
		results.push({
			url: data.AbstractURL,
			title: query,
			snippet: data.AbstractText,
		});
	}

	// Add related topics.
	if (data.RelatedTopics) {
		for (const topic of data.RelatedTopics) {
			if (topic.FirstURL && topic.Text) {
				results.push({
					url: topic.FirstURL,
					title: topic.Text.split(" - ")[0] ?? topic.Text,
					snippet: topic.Text,
				});
			}
		}
	}

	// Limit results.
	const limit = opts.numResults ?? 10;
	return results.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Engine registry — OCP: adding a new engine = one registerSearchEngine() call
// ---------------------------------------------------------------------------

/**
 * A factory that creates an ISearchEngine from an optional API key.
 * key is undefined for keyless engines (e.g. DDG).
 */
type EngineFactory = (key: string | undefined) => ISearchEngine;

/** The global engine registry. Seeded with built-in engines below. */
const ENGINE_REGISTRY = new Map<string, EngineFactory>();

/**
 * Register a search engine under a name.
 *
 * Call this to add a new engine without touching any existing code:
 * @example
 * registerSearchEngine("my-engine", (key) => new MyEngine(key!))
 */
export function registerSearchEngine(name: string, factory: EngineFactory): void {
	ENGINE_REGISTRY.set(name, factory);
}

/**
 * Resolve a registered engine by name, passing the provided API key.
 * Throws a descriptive error for unknown names or missing required keys.
 */
export function resolveSearchEngine(name: string, key?: string): ISearchEngine {
	const factory = ENGINE_REGISTRY.get(name);
	if (!factory) throw new Error(`Unknown search engine: "${name}". Register it with registerSearchEngine().`);
	return factory(key);
}

/** @internal Map engine name to its env var key name (for webSearch auto-detect). */
function envKeyForEngine(name: string): string {
	const envKeys: Record<string, string> = {
		brave: "BRAVE_SEARCH_API_KEY",
		tavily: "TAVILY_API_KEY",
		exa: "EXA_API_KEY",
	};
	return envKeys[name] ?? "";
}

// Seed the registry with built-in engines.
// Adding a new engine: call registerSearchEngine() — do NOT edit this block.
registerSearchEngine("brave", (key) => {
	if (!key) throw new Error("BRAVE_SEARCH_API_KEY not set");
	return new BraveSearchEngine(key);
});
registerSearchEngine("tavily", (key) => {
	if (!key) throw new Error("TAVILY_API_KEY not set");
	return new TavilySearchEngine(key);
});
registerSearchEngine("exa", (key) => {
	if (!key) throw new Error("EXA_API_KEY not set");
	return new ExaSearchEngine(key);
});
registerSearchEngine("ddg", () => new DdgSearchEngine());

// ---------------------------------------------------------------------------
// ISearchEngine adapters — concrete implementations of the port
// ---------------------------------------------------------------------------

/** Brave Search adapter implementing ISearchEngine. */
export class BraveSearchEngine implements ISearchEngine {
	constructor(
		private readonly apiKey: string,
		private readonly country?: string,
	) {}

	search(req: SearchQuery): Promise<WebSearchResult[]> {
		return braveSearch(req.query, { apiKey: this.apiKey, numResults: req.numResults, country: this.country });
	}
}

/** Tavily adapter implementing ISearchEngine. */
export class TavilySearchEngine implements ISearchEngine {
	constructor(private readonly apiKey: string) {}

	search(req: SearchQuery): Promise<WebSearchResult[]> {
		return tavilySearch(req.query, { apiKey: this.apiKey, numResults: req.numResults });
	}
}

/** Exa adapter implementing ISearchEngine. */
export class ExaSearchEngine implements ISearchEngine {
	constructor(private readonly apiKey: string) {}

	search(req: SearchQuery): Promise<WebSearchResult[]> {
		return exaSearch(req.query, { apiKey: this.apiKey, numResults: req.numResults });
	}
}

/** DuckDuckGo Instant Answer adapter — no API key required. */
export class DdgSearchEngine implements ISearchEngine {
	search(req: SearchQuery): Promise<WebSearchResult[]> {
		return ddgSearch(req.query, { numResults: req.numResults });
	}
}

// ---------------------------------------------------------------------------
// FallbackSearchEngine — strategy composite
// ---------------------------------------------------------------------------

export interface FallbackSearchEngineOptions {
	/**
	 * Treat an empty result set as a failure and try the next engine.
	 * Default: true.
	 */
	fallbackOnEmpty?: boolean;
	/**
	 * Swallow a thrown error and try the next engine instead of propagating.
	 * Default: true.
	 */
	fallbackOnError?: boolean;
}

/**
 * A composite ISearchEngine that tries each engine in order, falling back
 * to the next when the current one returns empty results or throws.
 *
 * Because it implements ISearchEngine itself it is fully composable —
 * nest FallbackSearchEngines, wrap them in caches, inject stubs in tests.
 *
 * @example
 * // Tavily with DDG as zero-cost fallback
 * const engine = new FallbackSearchEngine([
 *   new TavilySearchEngine(process.env.TAVILY_API_KEY),
 *   new DdgSearchEngine(),
 * ]);
 */
export class FallbackSearchEngine implements ISearchEngine {
	private readonly fallbackOnEmpty: boolean;
	private readonly fallbackOnError: boolean;

	constructor(
		private readonly engines: ISearchEngine[],
		opts: FallbackSearchEngineOptions = {},
	) {
		if (engines.length === 0) throw new Error("FallbackSearchEngine requires at least one engine");
		this.fallbackOnEmpty = opts.fallbackOnEmpty ?? true;
		this.fallbackOnError = opts.fallbackOnError ?? true;
	}

	async search(req: SearchQuery): Promise<WebSearchResult[]> {
		let lastError: unknown;

		for (const engine of this.engines) {
			try {
				const results = await engine.search(req);
				if (results.length > 0 || !this.fallbackOnEmpty) return results;
				// Empty + fallbackOnEmpty → try next engine
			} catch (err) {
				if (!this.fallbackOnError) throw err;
				lastError = err;
				// Error + fallbackOnError → try next engine
			}
		}

		// All engines exhausted — surface the last error or return empty
		if (lastError) {
			if (lastError instanceof Error) throw lastError;
			throw new Error("All search engines failed");
		}
		return [];
	}
}

// ---------------------------------------------------------------------------
// Wiring — compose engines from environment variables
// ---------------------------------------------------------------------------

/**
 * Build a FallbackSearchEngine chain from environment variables.
 *
 * Priority order for keyed engines: Brave → Tavily → Exa.
 * DuckDuckGo is always appended as the zero-cost last resort.
 *
 * The returned engine implements ISearchEngine — swap it for any stub
 * in tests without touching call sites.
 */
export function defaultSearchEngine(): ISearchEngine {
	const engines: ISearchEngine[] = [];

	const brave = process.env.BRAVE_SEARCH_API_KEY;
	if (brave) engines.push(new BraveSearchEngine(brave));

	const tavily = process.env.TAVILY_API_KEY;
	if (tavily) engines.push(new TavilySearchEngine(tavily));

	const exa = process.env.EXA_API_KEY;
	if (exa) engines.push(new ExaSearchEngine(exa));

	// DDG always last — no key needed, never throws the "no key" error
	engines.push(new DdgSearchEngine());

	return new FallbackSearchEngine(engines);
}

/**
 * Convenience wrapper for quick one-off searches.
 *
 * Uses defaultSearchEngine() to auto-detect API keys from environment variables.
 * Falls back through Brave → Tavily → Exa → DDG.
 *
 * @example
 * const results = await webSearch("latest TypeScript features");
 * console.log(results.map(r => r.title));
 */
export async function webSearch(
	query: string,
	opts: { numResults?: number; engine?: string } = {},
): Promise<WebSearchResult[]> {
	const engine = opts.engine
		? resolveSearchEngine(opts.engine, process.env[envKeyForEngine(opts.engine)])
		: defaultSearchEngine();
	return engine.search({ query, numResults: opts.numResults });
}
