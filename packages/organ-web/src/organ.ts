/**
 * WebOrgan — fetch web pages, search the web, and convert content to plain text.
 *
 * Tools:
 *   web.fetch(url, { format?, timeoutMs? })
 *     Fetches a URL and returns the content as plain text (default) or raw HTML.
 *     Strips scripts, styles, and navigation elements before returning.
 *     Returns { content, title, url, statusCode, truncated }.
 *
 *   web.search(query, { numResults?, engine? })
 *     Searches the web and returns ranked results with URLs, titles, and snippets.
 *     Uses Brave/Tavily/Exa (if API keys are set) or falls back to DuckDuckGo.
 *     Returns { results: [{ url, title, snippet, publishedAt? }] }.
 *
 * No external dependencies — uses Node.js built-in fetch (available since Node 18).
 * HTML-to-text conversion is handled inline: strips tags, collapses whitespace.
 *
 * Ref: TSK-181
 */

import type { Organ } from "@dpopsuev/alef-kernel";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	defineOrgan,
	truncateHead,
	typedAction,
	withDisplay,
} from "@dpopsuev/alef-kernel";
import { z } from "zod";
import { defaultSearchEngine, resolveSearchEngine } from "./search-engines.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// HTML → text conversion (inline, no deps)
// ---------------------------------------------------------------------------

/** Strip tags that contain non-content (scripts, styles, nav, etc.). */
function stripNonContent(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
		.replace(/<nav[\s\S]*?<\/nav>/gi, " ")
		.replace(/<footer[\s\S]*?<\/footer>/gi, " ")
		.replace(/<header[\s\S]*?<\/header>/gi, " ")
		.replace(/<aside[\s\S]*?<\/aside>/gi, " ");
}

/** Extract the <title> tag content. */
function extractTitle(html: string): string {
	const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	return m ? m[1].replace(/\s+/g, " ").trim() : "";
}

/** Convert HTML to readable plain text. */
function htmlToText(html: string): string {
	// Block elements that should become newlines.
	let text = html
		.replace(/<\/?(p|div|section|article|h[1-6]|li|dt|dd|blockquote|pre|br)[^>]*>/gi, "\n")
		.replace(/<\/?(tr|thead|tbody|tfoot)[^>]*>/gi, "\n")
		.replace(/<td[^>]*>/gi, "\t")
		.replace(/<[^>]+>/g, "") // strip remaining tags
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, " ")
		.replace(/&#\d+;/g, " ")
		.replace(/&[a-z]+;/gi, " ");

	// Collapse runs of blank lines to at most two.
	text = text.replace(/\n{3,}/g, "\n\n");
	// Collapse spaces within lines.
	text = text
		.split("\n")
		.map((l) => l.replace(/[ \t]+/g, " ").trim())
		.join("\n");

	return text.trim();
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const WEB_FETCH_TOOL = {
	name: "web.fetch",
	description:
		"Fetch a web page and return its content as plain text. " +
		"Use this to read documentation, articles, GitHub READMEs, or any public URL. " +
		"Content is stripped of scripts and navigation elements. " +
		"Set format='html' to get raw HTML when you need structure.",
	inputSchema: z.object({
		url: z.string().min(1).describe("The URL to fetch. Must start with http:// or https://."),
		format: z
			.enum(["text", "html"])
			.optional()
			.describe("Output format. 'text' (default) strips HTML tags. 'html' returns raw HTML."),
		timeoutMs: z.number().optional().describe("Request timeout in milliseconds. Default: 15000."),
	}),
};

const WEB_SEARCH_TOOL = {
	name: "web.search",
	description:
		"Search the web and return ranked results with URLs, titles, and snippets. " +
		"Use this when you don't know the exact URL or need to find current information. " +
		"Automatically tries Brave Search, Tavily, Exa, or falls back to DuckDuckGo. " +
		"Returns a list of results that you can then fetch with web.fetch.",
	inputSchema: z.object({
		query: z.string().min(1).describe("The search query. Natural language questions work well."),
		numResults: z.number().optional().describe("Maximum number of results to return. Default: 10."),
		engine: z
			.enum(["brave", "tavily", "exa", "ddg"])
			.optional()
			.describe("Specific search engine to use. Omit to use auto-fallback (Brave → Tavily → Exa → DDG)."),
	}),
};

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleFetch(url: string, format: "text" | "html", timeoutMs: number): Promise<Record<string, unknown>> {
	if (!url.startsWith("http://") && !url.startsWith("https://")) {
		throw new Error(`web.fetch: url must start with http:// or https://, got: ${url}`);
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);

	let response: Response;
	try {
		response = await fetch(url, {
			signal: controller.signal,
			headers: {
				"User-Agent": "Alef/1.0 (agent; +https://github.com/dpopsuev/alef)",
				Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
			},
			redirect: "follow",
		});
	} finally {
		clearTimeout(timer);
	}

	const statusCode = response.status;
	const rawBytes = await response.arrayBuffer();
	const rawText = new TextDecoder("utf-8", { fatal: false }).decode(rawBytes);

	if (format === "html") {
		const htmlTitle = extractTitle(rawText);
		const tr = truncateHead(rawText, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
		return { content: tr.content, title: htmlTitle, url: response.url, statusCode, truncated: tr.truncated };
	}

	const stripped = stripNonContent(rawText);
	const title = extractTitle(rawText);
	const tr = truncateHead(htmlToText(stripped), { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	return { content: tr.content, title, url: response.url, statusCode, truncated: tr.truncated };
}

async function handleSearch(query: string, numResults: number, engine?: string): Promise<Record<string, unknown>> {
	if (!query.trim()) {
		throw new Error("web.search: query cannot be empty");
	}

	const searchEngine = engine ? resolveSearchEngine(engine) : defaultSearchEngine();
	const results = await searchEngine.search({ query, numResults });

	return {
		query,
		results,
		hint: results.length > 0 ? "Use web.fetch(url=...) to read the full content of any result." : undefined,
	};
}

// ---------------------------------------------------------------------------
// Organ factory
// ---------------------------------------------------------------------------

export interface WebOrganOptions {
	/** Default request timeout in milliseconds. Default: 15000. */
	defaultTimeoutMs?: number;
}

const WEB_DIRECTIVES = [
	`**web.fetch tool guidance**
- Use web.fetch to read documentation, API references, GitHub READMEs, changelogs, and articles.
- Always prefer fs.read or lector.read for local files. web.fetch is for public URLs only.
- Content is returned as plain text by default. Use format='html' only when you need page structure.
- Respect robots.txt and rate limits. Do not fetch the same URL repeatedly in a loop.
- If a URL requires authentication or returns 4xx/5xx, report the statusCode and stop.

**web.search tool guidance**
- Use web.search when you don't know the exact URL or need to find current information.
- Pass natural language queries: "latest TypeScript features" or "Martin Fowler dependency injection".
- Never guess or hallucinate URLs. Search first, then fetch the result URLs.
- The tool automatically tries Brave → Tavily → Exa → DuckDuckGo based on available API keys.
- Results include url, title, snippet, and sometimes publishedAt. Use web.fetch to read full content.`,
];

export function createWebOrgan(options: WebOrganOptions = {}): Organ {
	const defaultTimeout = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;

	return defineOrgan(
		"web",
		{
			"motor/web.fetch": typedAction(WEB_FETCH_TOOL, async (ctx) => {
				const { url, format, timeoutMs } = ctx.payload;
				const result = await handleFetch(url, format ?? "text", timeoutMs ?? defaultTimeout);
				const title = result.title as string | undefined;
				const finalUrl = result.url as string;
				const label = title ? `**${title}** — ${finalUrl}` : finalUrl;
				return withDisplay(result, { text: label, mimeType: "text/markdown" });
			}),
			"motor/web.search": typedAction(WEB_SEARCH_TOOL, async (ctx) => {
				const { query, numResults, engine } = ctx.payload;
				const result = await handleSearch(query, numResults ?? 10, engine);
				const results = result.results as unknown[];
				return withDisplay(result, {
					text: `Web search: **${query}** (${results.length} results)`,
					mimeType: "text/markdown",
				});
			}),
		},
		{
			directives: WEB_DIRECTIVES,
			description: "Fetch and read public web pages, search the web for information.",
			labels: ["web", "fetch", "search", "http", "read"],
		},
	);
}
