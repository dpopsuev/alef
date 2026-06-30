/**
 * WebAdapter — fetch web pages, search the web, and convert content to clean Markdown.
 *
 * Tools:
 *   web.fetch(url, { format?, timeoutMs? })
 *     Fetches a URL via web-spider (Readability + Turndown).
 *     Returns structured output based on format:
 *       "markdown" (default) — clean article Markdown + metadata
 *       "lean"               — heading outline + body links, no body text
 *       "html"               — raw HTML (for sites that need structure)
 *     Returns { content, title, url, wordCount? }.
 *
 *   web.search(query, { numResults?, engine?, timeRange?, topic? })
 *     Searches via Brave/Tavily/Exa/DDG fallback chain.
 *     Returns { results: [{ url, title, snippet, publishedAt? }] }.
 *
 * Powered by @dpopsuev/web-spider — Readability + Turndown + structured output.
 */

import type { Adapter, PortDefinition } from "@dpopsuev/alef-kernel/adapter";
import { defineAdapter, typedAction } from "@dpopsuev/alef-kernel/adapter";
import { withLlmContent } from "@dpopsuev/alef-kernel/payload";
import {
	BraveSearchEngine,
	DdgSearchEngine,
	ExaSearchEngine,
	FallbackSearchEngine,
	type ISearchEngine,
	SpiderCache,
	type SpideredPage,
	type SpiderOptions,
	spider,
	TavilySearchEngine,
} from "@dpopsuev/web-spider";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Format helpers — maps SpideredPage to LLM-appropriate shapes
// (same pattern as web-spider's pi-extension format.ts)
// ---------------------------------------------------------------------------

/** Remove entries with undefined, empty string, or empty array values from an object. */
function omitEmpty(obj: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(obj).filter(([, v]) => v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0)),
	);
}

/** Transform a spidered page into a lean outline with headings and body links only. */
function _leanOutput(page: SpideredPage): Record<string, unknown> {
	return omitEmpty({
		url: page.url,
		title: page.title,
		description: page.description,
		author: page.author,
		publishedAt: page.publishedAt,
		wordCount: page.wordCount,
		headings: page.headings.map((h: { level: number; text: string }) => `${"#".repeat(h.level)} ${h.text}`),
		bodyLinks: page.links
			.filter((l: { rel: string }) => l.rel === "body")
			.map((l: { href: string; text: string }) => ({ href: l.href, text: l.text })),
		// eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- false must coerce to undefined for omitEmpty
		jsRendered: page.jsRendered || undefined,
	});
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const WEB_FETCH_TOOL = {
	name: "web.fetch",
	description:
		"Fetch a web page and return its content. " +
		"Uses Readability for article extraction and Turndown for Markdown conversion. " +
		"Default format 'markdown' returns clean article text; 'lean' returns outline only; 'html' returns raw HTML.",
	inputSchema: z.object({
		url: z.string().min(1).describe("The URL to fetch. Must start with http:// or https://."),
		format: z
			.enum(["markdown", "lean", "html"])
			.optional()
			.describe(
				"Output format. " +
					"'markdown' (default) — clean article Markdown, best for reading content. " +
					"'lean' — heading outline + body links only, best for triage before reading. " +
					"'html' — raw HTML, for pages that require structure.",
			),
		timeoutMs: z.number().optional().describe("Request timeout in milliseconds. Default: 30000."),
		tokenBudget: z
			.number()
			.optional()
			.describe("Approximate token limit for the returned content (1 token ≈ 4 chars). Default: unlimited."),
	}),
};

const WEB_SEARCH_TOOL = {
	name: "web.search",
	description:
		"Search the web and return ranked results with URLs, titles, and snippets. " +
		"Automatically tries Brave Search, Tavily, Exa, or falls back to DuckDuckGo. " +
		"Returns a list of results that you can then fetch with web.fetch.",
	inputSchema: z.object({
		query: z.string().min(1).describe("The search query. Natural language questions work well."),
		numResults: z.number().optional().describe("Maximum number of results to return. Default: 10."),
		engine: z
			.enum(["brave", "tavily", "exa", "ddg"])
			.optional()
			.describe("Specific search engine to use. Omit to use auto-fallback (Brave → Tavily → Exa → DDG)."),
		timeRange: z
			.enum(["day", "week", "month", "year"])
			.optional()
			.describe(
				"Restrict results to content published within this window. " +
					"Use 'month' when asked for recent or latest news. Supported by Tavily and Brave.",
			),
		topic: z
			.enum(["news", "general"])
			.optional()
			.describe(
				"Search topic mode. 'news' prioritises freshly indexed news articles. " +
					"Use with timeRange:'month' when asked for recent developments.",
			),
	}),
};

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

/** Configuration for the web adapter including default timeout and action allowlist. */
export interface WebAdapterOptions {
	/** Default request timeout in milliseconds. Default: 30000. */
	defaultTimeoutMs?: number;
	/** Allowlist of web action names to mount (e.g. ['web.fetch']). Default: all. */
	actions?: readonly string[];
}

const WEB_DIRECTIVES = [
	`**web.fetch tool guidance**
- Use web.fetch to read documentation, API references, GitHub READMEs, changelogs, and articles.
- Always prefer fs.read or code.read for local files. web.fetch is for public URLs only.
- Default format 'markdown' returns clean article text — use this for reading content.
- Use format='lean' to skim a page before deciding whether to read it — much cheaper.
- Use format='html' only when you need raw page structure.
- If a URL requires authentication or returns 4xx/5xx, report the statusCode and stop.

**web.search tool guidance**
- Use web.search when you don't know the exact URL or need to find current information.
- Pass natural language queries: "latest TypeScript features" or "ona background agents".
- Never guess or hallucinate URLs. Search first, then fetch the result URLs.
- The tool automatically tries Brave → Tavily → Exa → DuckDuckGo based on available API keys.
- Results include url, title, snippet, and sometimes publishedAt. Use web.fetch to read full content.
- When asked for recent or latest news: pass timeRange:'month' and topic:'news'.
- If a named company or startup search returns no results: try web.fetch('https://{company-name}.com') directly.`,
];

/** Build a web adapter with fetch and search actions backed by Readability and a search engine fallback chain. */
export function createWebAdapter(options: WebAdapterOptions = {}): Adapter {
	const defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;

	// Session-scoped LRU cache — pages fetched during this session are reused.
	const cache = new SpiderCache({ maxSize: 50, ttlMs: 30 * 60 * 1000 });

	/** Build the search engine fallback chain from available API keys, or use the named engine. */
	function buildSearchEngine(engineName?: string): ISearchEngine {
		if (engineName) {
			const key: Record<string, string | undefined> = {
				brave: process.env.BRAVE_SEARCH_API_KEY,
				tavily: process.env.TAVILY_API_KEY,
				exa: process.env.EXA_API_KEY,
			};
			switch (engineName) {
				case "brave":
					return new BraveSearchEngine(key.brave ?? "");
				case "tavily":
					return new TavilySearchEngine(key.tavily ?? "");
				case "exa":
					return new ExaSearchEngine(key.exa ?? "");
				case "ddg":
					return new DdgSearchEngine();
				default:
					return new DdgSearchEngine();
			}
		}
		const engines: ISearchEngine[] = [];
		if (process.env.BRAVE_SEARCH_API_KEY) engines.push(new BraveSearchEngine(process.env.BRAVE_SEARCH_API_KEY));
		if (process.env.TAVILY_API_KEY) engines.push(new TavilySearchEngine(process.env.TAVILY_API_KEY));
		if (process.env.EXA_API_KEY) engines.push(new ExaSearchEngine(process.env.EXA_API_KEY));
		engines.push(new DdgSearchEngine());
		return new FallbackSearchEngine(engines);
	}

	return defineAdapter(
		"web",
		{
			command: {
				"web.fetch": typedAction(WEB_FETCH_TOOL, async (ctx) => {
					const { url, format = "markdown", timeoutMs, tokenBudget } = ctx.payload;

					// Raw HTML path — bypass Readability.
					if (format === "html") {
						if (!url.startsWith("http://") && !url.startsWith("https://")) {
							throw new Error(`web.fetch: url must start with http:// or https://, got: ${url}`);
						}
						const controller = new AbortController();
						// lint-ignore: RAWTIMER HTTP fetch abort deadline
						const timer = setTimeout(() => controller.abort(), timeoutMs ?? defaultTimeoutMs);
						let response: Response;
						try {
							response = await fetch(url, {
								signal: controller.signal,
								headers: { "User-Agent": "Alef/1.0 (agent)", Accept: "text/html" },
								redirect: "follow",
							});
						} finally {
							clearTimeout(timer);
						}
						const rawText = await response.text();
						const title =
							/<title[^>]*>([\s\S]*?)<\/title>/i.exec(rawText)?.[1]?.replace(/\s+/g, " ").trim() ?? "";
						return withLlmContent(
							rawText,
							{ title, url: response.url, statusCode: response.status },
							{
								text: title ? `**${title}** — ${response.url}` : response.url,
								mimeType: "text/plain",
							},
						);
					}

					// Readability + Turndown path via web-spider.
					const spiderOpts: SpiderOptions = {
						timeoutMs: timeoutMs ?? defaultTimeoutMs,
						...(tokenBudget !== undefined ? { tokenBudget } : {}),
					};

					const fetchUrl = async <T>(fn: () => Promise<T>): Promise<T> => {
						try {
							return await fn();
						} catch (e) {
							const msg = e instanceof Error ? e.message : String(e);
							throw new Error(`web.fetch failed for ${url}: ${msg}`);
						}
					};

					// Check in-session cache first.
					const cacheKey = url;
					const cached = cache.get(cacheKey);
					let page: SpideredPage;
					if (cached) {
						page = cached;
					} else {
						if (format === "lean") {
							const lean = await fetchUrl(() =>
								spider(url, {
									...(spiderOpts as Parameters<typeof spider>[1]),
									view: "lean" as const,
								}),
							);
							return withLlmContent(
								JSON.stringify(
									omitEmpty({
										url: lean.url,
										title: lean.title,
										description: lean.description,
										wordCount: lean.wordCount,
										headings: lean.headings,
										bodyLinks: lean.links,
										jsRendered: lean.jsRendered,
									}),
								),
								{ url: lean.url },
								{
									text: `Lean: **${lean.title || lean.url}** — ${lean.wordCount} words`,
									mimeType: "text/plain",
								},
							);
						}
						page = await fetchUrl(() => spider(url, spiderOpts as Parameters<typeof spider>[1]));
						cache.set(cacheKey, page);
					}

					const metadata = omitEmpty({
						url: page.url,
						title: page.title,
						author: page.author,
						publishedAt: page.publishedAt,
						wordCount: page.wordCount,
					});

					const label = page.title ? `**${page.title}** — ${page.url}` : page.url;

					return withLlmContent(page.markdown, metadata, {
						text: label,
						mimeType: "text/markdown",
					});
				}),

				"web.search": typedAction(WEB_SEARCH_TOOL, async (ctx) => {
					const { query, numResults, engine, timeRange, topic } = ctx.payload;
					if (!query.trim()) throw new Error("web.search: query cannot be empty");

					const searchEngine = buildSearchEngine(engine);
					const results = await searchEngine.search({ query, numResults: numResults ?? 10, timeRange, topic });

					return withLlmContent(
						JSON.stringify({ query, results }),
						{},
						{
							text: `Web search: **${query}** (${results.length} results)`,
							mimeType: "text/plain",
						},
					);
				}),
			},
		},
		{
			actions: options.actions,
			directives: WEB_DIRECTIVES,
			description: "Fetch and read public web pages, search the web for information.",
			labels: ["web", "fetch", "search", "http", "read"],
			contributions: {
				port: { name: "web", eventPattern: "command/web.", cardinality: "zero-or-one" } satisfies PortDefinition,
				"event.weights": { "web.fetch": 0.9 },
				history: {
					ownedTools: ["web.fetch", "web.search"],
					extractEntry: (payload) => {
						const url = typeof payload.url === "string" ? payload.url : undefined;
						const query = typeof payload.query === "string" ? payload.query : undefined;
						return url ? { url } : query ? { query } : null;
					},
				},
			},
		},
	);
}
