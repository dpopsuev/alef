/**
 * WebOrgan — fetch web pages and convert them to plain text.
 *
 * Tools:
 *   web.fetch(url, { format?, timeoutMs? })
 *     Fetches a URL and returns the content as plain text (default) or raw HTML.
 *     Strips scripts, styles, and navigation elements before returning.
 *     Returns { content, title, url, statusCode, truncated }.
 *
 * No external dependencies — uses Node.js built-in fetch (available since Node 18).
 * HTML-to-text conversion is handled inline: strips tags, collapses whitespace.
 *
 * Ref: TSK-181
 */

import type { CorpusHandlerCtx, Organ } from "@dpopsuev/alef-spine";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, defineOrgan, truncateHead } from "@dpopsuev/alef-spine";
import { z } from "zod";

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
// Tool definition
// ---------------------------------------------------------------------------

const WEB_FETCH_TOOL = {
	name: "web.fetch",
	description:
		"Fetch a web page and return its content as plain text. " +
		"Use this to read documentation, articles, GitHub READMEs, or any public URL. " +
		"Content is stripped of scripts and navigation elements. " +
		"Set format='html' to get raw HTML when you need structure.",
	inputSchema: z.object({
		url: z.string().describe("The URL to fetch. Must start with http:// or https://."),
		format: z
			.enum(["text", "html"])
			.optional()
			.describe("Output format. 'text' (default) strips HTML tags. 'html' returns raw HTML."),
		timeoutMs: z.number().optional().describe("Request timeout in milliseconds. Default: 15000."),
	}),
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function handleFetch(
	url: string,
	format: "text" | "html",
	timeoutMs: number,
): Promise<{ content: string; title: string; url: string; statusCode: number; truncated: boolean }> {
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
		const tr = truncateHead(rawText, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
		return {
			content: tr.content,
			title: extractTitle(rawText),
			url: response.url,
			statusCode,
			truncated: tr.truncated,
		};
	}

	const stripped = stripNonContent(rawText);
	const title = extractTitle(rawText);
	const tr = truncateHead(htmlToText(stripped), { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	return { content: tr.content, title, url: response.url, statusCode, truncated: tr.truncated };
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
- If a URL requires authentication or returns 4xx/5xx, report the statusCode and stop.`,
];

export function createWebOrgan(options: WebOrganOptions = {}): Organ {
	const defaultTimeout = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;

	return defineOrgan(
		"web",
		{
			"motor/web.fetch": {
				tool: WEB_FETCH_TOOL,
				handle: async (ctx: CorpusHandlerCtx) => {
					const url = String(ctx.payload.url ?? "");
					const format = ctx.payload.format === "html" ? "html" : "text";
					const timeoutMs = typeof ctx.payload.timeoutMs === "number" ? ctx.payload.timeoutMs : defaultTimeout;
					return (await handleFetch(url, format, timeoutMs)) as unknown as Record<string, unknown>;
				},
			},
		},
		{
			directives: WEB_DIRECTIVES,
			description: "Fetch and read public web pages, documentation, and articles.",
			labels: ["web", "fetch", "http", "read"],
		},
	);
}
