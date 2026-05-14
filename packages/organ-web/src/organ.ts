/**
 * WebOrgan — CorpusOrgan for web fetch, search, crawl, and graph.
 *
 * Wraps @dpopsuev/web-spider. Session-scoped SpiderCache + PageGraph
 * shared across all tool calls within one mount lifecycle.
 *
 * Motor events → Sense events (same name, different bus):
 *   web.fetch   — fetch a single URL, return structured page summary
 *   web.search  — DuckDuckGo search + spider top N results in parallel
 *   web.crawl   — recursive BFS crawl from a start URL
 *   web.graph   — query the session knowledge graph
 */

import type { CorpusNerve, CorpusOrgan, MotorEvent, SenseEvent, ToolDefinition } from "@dpopsuev/alef-spine";
import type { SpideredPage } from "@dpopsuev/web-spider";
import { batchSpider, crawl, PageGraph, SpiderCache, spider } from "@dpopsuev/web-spider";

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS: ToolDefinition[] = [
	{
		name: "web.fetch",
		description:
			"Fetch a single URL and return structured content: title, description, headings, RAG-ready chunks, and outbound links. Session-scoped LRU cache — repeated calls to the same URL are free.",
		inputSchema: {
			type: "object",
			properties: {
				url: { type: "string", description: "Fully qualified URL to fetch (https://...)" },
				full: {
					type: "boolean",
					description: "Include full markdown body in addition to preview (default false)",
				},
			},
			required: ["url"],
		},
	},
	{
		name: "web.search",
		description:
			"Search DuckDuckGo and spider the top results. Returns structured content for each page — ready to read without further fetching.",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string", description: "Search query" },
				maxResults: {
					type: "number",
					description: "Max pages to fetch (1–8, default 4)",
					minimum: 1,
					maximum: 8,
				},
				concurrency: { type: "number", description: "Parallel fetches (default 3)" },
			},
			required: ["query"],
		},
	},
	{
		name: "web.crawl",
		description:
			"Recursively spider a site starting from a URL. Follows internal links up to maxDepth hops. Returns a summary of all pages and graph statistics.",
		inputSchema: {
			type: "object",
			properties: {
				url: { type: "string", description: "Start URL for the crawl" },
				maxDepth: {
					type: "number",
					description: "Link hops from start (default 1, max 4)",
					minimum: 0,
					maximum: 4,
				},
				maxPages: {
					type: "number",
					description: "Hard cap on pages fetched (default 10, max 50)",
					minimum: 1,
					maximum: 50,
				},
				sameDomainOnly: { type: "boolean", description: "Stay on the same domain (default true)" },
			},
			required: ["url"],
		},
	},
	{
		name: "web.graph",
		description:
			"Query the in-session knowledge graph built from pages fetched so far. Actions: snapshot (full graph), path (BFS between two URLs), neighbors (links from a URL), rank (pages by inbound link count).",
		inputSchema: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: ["snapshot", "path", "neighbors", "rank"],
					description: "snapshot | path | neighbors | rank",
				},
				url: { type: "string", description: "Source URL (path, neighbors)" },
				target: { type: "string", description: "Target URL (path)" },
				topN: { type: "number", description: "Limit for rank (default 10)" },
			},
			required: ["action"],
		},
	},
];

// ---------------------------------------------------------------------------
// Organ factory
// ---------------------------------------------------------------------------

export interface WebOrganOptions {
	/** LRU cache max entries (default 200). */
	cacheMaxSize?: number;
	/** LRU cache TTL in ms (default 20 min). */
	cacheTtlMs?: number;
	/** Timeout per page fetch in ms (default 12s). */
	fetchTimeoutMs?: number;
}

export function createWebOrgan(options: WebOrganOptions = {}): CorpusOrgan {
	return {
		kind: "corpus",
		name: "web",
		tools: TOOLS,

		mount(nerve: CorpusNerve): () => void {
			// Session-scoped cache + graph — created at mount, torn down at unmount.
			const cache = new SpiderCache({
				maxSize: options.cacheMaxSize ?? 200,
				ttlMs: options.cacheTtlMs ?? 20 * 60 * 1000,
			});
			const graph = new PageGraph();
			const fetchTimeoutMs = options.fetchTimeoutMs ?? 12_000;

			const offs = [
				nerve.motor.subscribe("web.fetch", (e) => handleFetch(e, nerve, cache, graph, fetchTimeoutMs)),
				nerve.motor.subscribe("web.search", (e) => handleSearch(e, nerve, cache, graph, fetchTimeoutMs)),
				nerve.motor.subscribe("web.crawl", (e) => handleCrawl(e, nerve, cache, graph)),
				nerve.motor.subscribe("web.graph", (e) => handleGraph(e, nerve, graph)),
			];

			return () => {
				for (const off of offs) off();
			};
		},
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSense(
	motor: MotorEvent,
	payload: Record<string, unknown>,
	isError = false,
	errorMessage?: string,
): SenseEvent {
	const toolCallId = typeof motor.payload.toolCallId === "string" ? motor.payload.toolCallId : undefined;
	return {
		type: motor.type,
		correlationId: motor.correlationId,
		timestamp: Date.now(),
		payload: toolCallId ? { ...payload, toolCallId } : payload,
		isError,
		errorMessage,
	};
}

function errSense(motor: MotorEvent, message: string): SenseEvent {
	const toolCallId = typeof motor.payload.toolCallId === "string" ? motor.payload.toolCallId : undefined;
	return {
		type: motor.type,
		correlationId: motor.correlationId,
		timestamp: Date.now(),
		payload: toolCallId ? { toolCallId } : {},
		isError: true,
		errorMessage: message,
	};
}

/** Summarise a SpideredPage for LLM context — structured, no raw HTML. */
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
		headings: page.headings.map((h) => `${"#".repeat(h.level)} ${h.text}`),
		chunkCount: page.chunks.length,
		linkCount: page.links.length,
		preview: page.chunks.slice(0, 3).map((c) => ({
			heading: c.heading,
			wordCount: c.wordCount,
			text: c.text.slice(0, 400),
		})),
	};
}

/** DuckDuckGo HTML endpoint search — returns deduplicated result URLs. */
async function ddgSearch(query: string, maxResults = 8): Promise<string[]> {
	const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
	const res = await fetch(url, {
		headers: { "User-Agent": "alef-web-organ/0.1 (agent research tool)" },
	});
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
// Handlers
// ---------------------------------------------------------------------------

async function handleFetch(
	motor: MotorEvent,
	nerve: CorpusNerve,
	cache: SpiderCache,
	graph: PageGraph,
	timeoutMs: number,
): Promise<void> {
	const url = String(motor.payload.url ?? "");
	if (!url) {
		nerve.sense.publish(errSense(motor, "web.fetch: url is required"));
		return;
	}

	try {
		const cached = cache.get(url);
		const page = cached ?? (await spider(url, { timeoutMs }));
		if (!cached) {
			cache.set(url, page);
			graph.addPage(page);
		}

		const result = motor.payload.full ? { ...summarise(page), markdown: page.markdown } : summarise(page);

		nerve.sense.publish(makeSense(motor, result as Record<string, unknown>));
	} catch (e) {
		nerve.sense.publish(errSense(motor, `web.fetch: ${e instanceof Error ? e.message : String(e)}`));
	}
}

async function handleSearch(
	motor: MotorEvent,
	nerve: CorpusNerve,
	cache: SpiderCache,
	graph: PageGraph,
	_timeoutMs: number,
): Promise<void> {
	const query = String(motor.payload.query ?? "");
	if (!query) {
		nerve.sense.publish(errSense(motor, "web.search: query is required"));
		return;
	}

	const max = typeof motor.payload.maxResults === "number" ? motor.payload.maxResults : 4;
	const concurrency = typeof motor.payload.concurrency === "number" ? motor.payload.concurrency : 3;

	try {
		const urls = await ddgSearch(query, max);
		if (urls.length === 0) {
			nerve.sense.publish(makeSense(motor, { query, pages: [], errors: [] }));
			return;
		}

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

		nerve.sense.publish(makeSense(motor, { query, pages, errors } as unknown as Record<string, unknown>));
	} catch (e) {
		nerve.sense.publish(errSense(motor, `web.search: ${e instanceof Error ? e.message : String(e)}`));
	}
}

async function handleCrawl(motor: MotorEvent, nerve: CorpusNerve, cache: SpiderCache, graph: PageGraph): Promise<void> {
	const url = String(motor.payload.url ?? "");
	if (!url) {
		nerve.sense.publish(errSense(motor, "web.crawl: url is required"));
		return;
	}

	try {
		const { pages, errors } = await crawl(url, {
			maxDepth: typeof motor.payload.maxDepth === "number" ? motor.payload.maxDepth : 1,
			maxPages: typeof motor.payload.maxPages === "number" ? motor.payload.maxPages : 10,
			sameDomainOnly: motor.payload.sameDomainOnly !== false,
			concurrency: 3,
			delayMs: 400,
			cache,
			graph,
		});

		const snap = graph.toJSON();
		const byRank = graph.byPageRank().slice(0, 10);

		const result = {
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
		};

		nerve.sense.publish(makeSense(motor, result as unknown as Record<string, unknown>));
	} catch (e) {
		nerve.sense.publish(errSense(motor, `web.crawl: ${e instanceof Error ? e.message : String(e)}`));
	}
}

function handleGraph(motor: MotorEvent, nerve: CorpusNerve, graph: PageGraph): void {
	const action = String(motor.payload.action ?? "");
	let result: unknown;

	try {
		switch (action) {
			case "snapshot":
				result = graph.toJSON();
				break;
			case "path": {
				const from = String(motor.payload.url ?? "");
				const to = String(motor.payload.target ?? "");
				if (!from || !to) throw new Error("path requires url and target");
				const path = graph.findPath(from, to);
				result = { from, to, path, reachable: path !== null };
				break;
			}
			case "neighbors": {
				const url = String(motor.payload.url ?? "");
				if (!url) throw new Error("neighbors requires url");
				result = { url, outbound: graph.outbound(url), inbound: graph.inbound(url) };
				break;
			}
			case "rank":
				result = {
					rank: graph.byPageRank().slice(0, typeof motor.payload.topN === "number" ? motor.payload.topN : 10),
				};
				break;
			default:
				throw new Error(`unknown action: ${action}. Use: snapshot | path | neighbors | rank`);
		}
		nerve.sense.publish(makeSense(motor, result as Record<string, unknown>));
	} catch (e) {
		nerve.sense.publish(errSense(motor, `web.graph: ${e instanceof Error ? e.message : String(e)}`));
	}
}
