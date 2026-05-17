/**
 * WebOrgan — web fetch, search, crawl, and graph CorpusOrgan.
 *
 * Session-scoped SpiderCache + PageGraph created at mount, torn down on unmount.
 *
 * Motor → Sense (same name, different bus):
 *   web.fetch, web.search, web.crawl, web.graph
 */

import type { CorpusHandlerCtx, Organ } from "@dpopsuev/alef-spine";
import { defineCorpusOrgan } from "@dpopsuev/alef-spine";
import type { SpideredPage } from "@dpopsuev/web-spider";
import { batchSpider, crawl, PageGraph, SpiderCache, spider } from "@dpopsuev/web-spider";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const WEB_FETCH_TOOL = {
	name: "web.fetch",
	description:
		"Fetch a single URL and return structured content: title, description, headings, chunks, links. Cached per session.",
	inputSchema: z.object({
		url: z.string().describe("Fully qualified URL (https://...)"),
		full: z.boolean().optional().describe("Include full markdown body (default false)"),
	}),
};

const WEB_SEARCH_TOOL = {
	name: "web.search",
	description: "Search DuckDuckGo and spider top results. Returns structured content for each page.",
	inputSchema: z.object({
		query: z.string().describe("Search query"),
		maxResults: z.number().min(1).max(8).optional().describe("Max pages to fetch (1–8, default 4)"),
		concurrency: z.number().optional().describe("Parallel fetches (default 3)"),
	}),
};

const WEB_CRAWL_TOOL = {
	name: "web.crawl",
	description: "Recursively spider a site from a start URL. Returns all pages and graph statistics.",
	inputSchema: z.object({
		url: z.string().describe("Start URL"),
		maxDepth: z.number().min(0).max(4).optional().describe("Link hops from start (default 1, max 4)"),
		maxPages: z.number().min(1).max(50).optional().describe("Hard cap on pages (default 10, max 50)"),
		sameDomainOnly: z.boolean().optional().describe("Stay on same domain (default true)"),
	}),
};

const WEB_GRAPH_TOOL = {
	name: "web.graph",
	description: "Query the session knowledge graph of fetched pages. Actions: snapshot | path | neighbors | rank.",
	inputSchema: z.object({
		action: z.enum(["snapshot", "path", "neighbors", "rank"]).describe("Action to perform"),
		url: z.string().optional().describe("Source URL (path, neighbors)"),
		target: z.string().optional().describe("Target URL (path)"),
		topN: z.number().optional().describe("Limit for rank (default 10)"),
	}),
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface WebOrganOptions {
	cacheMaxSize?: number;
	cacheTtlMs?: number;
	fetchTimeoutMs?: number;
	/** Allowlist of web action names to mount. Default: all. */
	actions?: readonly string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function summarise(page: SpideredPage) {
	return {
		url: page.url,
		domain: page.domain,
		title: page.title,
		description: page.description,
		author: page.author,
		publishedAt: page.publishedAt,
		wordCount: page.wordCount,
		readingTimeMinutes: page.readingTimeMinutes,
		headings: page.headings.map((h: { level: number; text: string }) => `${"#".repeat(h.level)} ${h.text}`),
		chunkCount: page.chunks.length,
		linkCount: page.links.length,
		preview: page.chunks.slice(0, 3).map((c: { heading?: string; wordCount: number; text: string }) => ({
			heading: c.heading,
			wordCount: c.wordCount,
			text: c.text.slice(0, 400),
		})),
	};
}

async function ddgSearch(query: string, maxResults = 8): Promise<string[]> {
	const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
	const res = await fetch(url, { headers: { "User-Agent": "alef-web-organ/0.1 (agent research tool)" } });
	const html = await res.text();
	const seen = new Set<string>();
	const urls: string[] = [];
	for (const match of html.matchAll(/uddg=([^&"]+)/g)) {
		try {
			const decoded = decodeURIComponent(match[1]);
			if (!seen.has(decoded) && decoded.startsWith("http")) {
				seen.add(decoded);
				urls.push(decoded);
				if (urls.length >= maxResults) break;
			}
		} catch {
			/* skip malformed */
		}
	}
	return urls;
}

// ---------------------------------------------------------------------------
// Handlers (pure functions — no nerve, no makeSense)
// ---------------------------------------------------------------------------

async function handleFetch(
	ctx: CorpusHandlerCtx,
	cache: SpiderCache,
	graph: PageGraph,
	timeoutMs: number,
): Promise<Record<string, unknown>> {
	const url = String(ctx.payload.url ?? "");
	if (!url) throw new Error("web.fetch: url is required");
	const cached = cache.get(url);
	const page = cached ?? (await spider(url, { timeoutMs }));
	if (!cached) {
		cache.set(url, page);
		graph.addPage(page);
	}
	return ctx.payload.full
		? ({ ...summarise(page), markdown: page.markdown } as Record<string, unknown>)
		: (summarise(page) as unknown as Record<string, unknown>);
}

async function handleSearch(
	ctx: CorpusHandlerCtx,
	cache: SpiderCache,
	graph: PageGraph,
): Promise<Record<string, unknown>> {
	const query = String(ctx.payload.query ?? "");
	if (!query) throw new Error("web.search: query is required");
	const max = typeof ctx.payload.maxResults === "number" ? ctx.payload.maxResults : 4;
	const concurrency = typeof ctx.payload.concurrency === "number" ? ctx.payload.concurrency : 3;

	const urls = await ddgSearch(query, max);
	if (urls.length === 0) return { query, pages: [], errors: [] };

	const results = await batchSpider(urls, {
		concurrency,
		delayMs: 300,
		cache,
		onProgress: (_done: number, _total: number, url: string) => {
			const page = cache.get(url);
			if (page) graph.addPage(page);
		},
	});

	const pages: ReturnType<typeof summarise>[] = [];
	const errors: { url: string; error: string }[] = [];
	for (const [url, result] of results) {
		if (result instanceof Error) errors.push({ url, error: result.message });
		else pages.push(summarise(result));
	}
	return { query, pages, errors } as unknown as Record<string, unknown>;
}

async function handleCrawl(
	ctx: CorpusHandlerCtx,
	cache: SpiderCache,
	graph: PageGraph,
): Promise<Record<string, unknown>> {
	const url = String(ctx.payload.url ?? "");
	if (!url) throw new Error("web.crawl: url is required");

	const { pages, errors } = await crawl(url, {
		maxDepth: typeof ctx.payload.maxDepth === "number" ? ctx.payload.maxDepth : 1,
		maxPages: typeof ctx.payload.maxPages === "number" ? ctx.payload.maxPages : 10,
		sameDomainOnly: ctx.payload.sameDomainOnly !== false,
		concurrency: 3,
		delayMs: 400,
		cache,
		graph,
	});

	const snap = graph.toJSON();
	const byRank = graph.byPageRank().slice(0, 10);
	return {
		startUrl: url,
		pageCount: pages.size,
		errorCount: errors.size,
		graph: {
			nodes: snap.nodes.length,
			edges: snap.edges.length,
			roots: graph.roots().map((n: { url: string }) => n.url),
			sinks: graph.sinks().map((n: { url: string }) => n.url),
			topByInboundLinks: byRank.map((r: { node: { url: string; title: string }; inboundCount: number }) => ({
				url: r.node.url,
				title: r.node.title,
				inbound: r.inboundCount,
			})),
		},
		pages: [...pages.values()].map(summarise),
		errors: [...errors.entries()].map(([u, e]) => ({ url: u, error: e.message })),
	} as unknown as Record<string, unknown>;
}

function handleGraph(ctx: CorpusHandlerCtx, graph: PageGraph): Record<string, unknown> {
	const action = String(ctx.payload.action ?? "");
	switch (action) {
		case "snapshot":
			return graph.toJSON() as unknown as Record<string, unknown>;
		case "path": {
			const from = String(ctx.payload.url ?? "");
			const to = String(ctx.payload.target ?? "");
			if (!from || !to) throw new Error("web.graph path requires url and target");
			const path = graph.findPath(from, to);
			return { from, to, path, reachable: path !== null };
		}
		case "neighbors": {
			const url = String(ctx.payload.url ?? "");
			if (!url) throw new Error("web.graph neighbors requires url");
			return { url, outbound: graph.outbound(url), inbound: graph.inbound(url) };
		}
		case "rank":
			return { rank: graph.byPageRank().slice(0, typeof ctx.payload.topN === "number" ? ctx.payload.topN : 10) };
		default:
			throw new Error(`web.graph: unknown action: ${action}. Use: snapshot | path | neighbors | rank`);
	}
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createWebOrgan(options: WebOrganOptions = {}): Organ {
	// Session-scoped state — created once per mount lifecycle
	const cache = new SpiderCache({
		maxSize: options.cacheMaxSize ?? 200,
		ttlMs: options.cacheTtlMs ?? 20 * 60 * 1000,
	});
	const graph = new PageGraph();
	const timeoutMs = options.fetchTimeoutMs ?? 12_000;

	return defineCorpusOrgan(
		"web",
		{
			"web.fetch": { tool: WEB_FETCH_TOOL, handle: (ctx) => handleFetch(ctx, cache, graph, timeoutMs) },
			"web.search": { tool: WEB_SEARCH_TOOL, handle: (ctx) => handleSearch(ctx, cache, graph) },
			"web.crawl": { tool: WEB_CRAWL_TOOL, handle: (ctx) => handleCrawl(ctx, cache, graph) },
			"web.graph": { tool: WEB_GRAPH_TOOL, handle: async (ctx) => handleGraph(ctx, graph) },
		},
		{ actions: options.actions },
	);
}
