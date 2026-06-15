/**
 * Typed payload accessors for Record<string, unknown> event payloads.
 *
 * Every bus event payload is Record<string, unknown>. These helpers narrow a
 * field to the expected primitive type, returning undefined (or a provided
 * default) when the field is absent or the wrong type.
 *
 * Eliminates the 39-occurrence pattern of:
 *   typeof ctx.payload.path === "string" ? ctx.payload.path : ""
 *
 * Usage:
 *   import { getString, getNumber, getBoolean } from "@dpopsuev/alef-kernel";
 *   const path = getString(ctx.payload, "path") ?? "";
 *   const limit = getNumber(ctx.payload, "limit");
 *   const hidden = getBoolean(ctx.payload, "hidden") ?? false;
 */

// ---------------------------------------------------------------------------
// Dual-channel tool output
// ---------------------------------------------------------------------------

/**
 * Human-readable display block attached to sense payloads.
 *
 * Organs include this on their sense results so the TUI can render
 * something meaningful instead of raw JSON. organ-llm strips it before
 * encoding the payload into the LLM’s tool-result context.
 *
 * Mirrors the MCP content-block `annotations.audience` pattern:
 *   audience:["assistant"] → the main payload (LLM channel)
 *   audience:["user"]      → _display (TUI channel)
 */
export interface SenseDisplayBlock {
	/** Human-readable text. Markdown is rendered by the TUI; plain is shown verbatim. */
	text: string;
	mimeType: "text/markdown" | "text/plain" | "text/x-diff";
}

/**
 * Attach a display block to a sense payload without mutating the original.
 *
 * Usage in organ handlers:
 *   return withDisplay({ content, truncated }, { text: `Read **${path}**`, mimeType: "text/plain" });
 */
export function withDisplay(payload: Record<string, unknown>, display: SenseDisplayBlock): Record<string, unknown> {
	return { ...payload, _display: display };
}

/**
 * Build a dual-channel sense result where the LLM receives a clean string and
 * the TUI receives a formatted pill.
 *
 * The primary content is always placed in the `content` field — the name that
 * `payloadToText` checks first. Any extra metadata is merged at the top level.
 * The `content` key in `metadata` is silently overwritten to prevent shadowing.
 *
 * Use this instead of constructing `{ content, ...meta, _display }` by hand:
 * the explicit helper makes the convention visible and prevents the common
 * mistake of naming the field `markdown`, `text`, or `body`, which would cause
 * `payloadToText` to silently fall through to `JSON.stringify`.
 *
 * @example
 * return withLlmContent(page.markdown, { url, title, wordCount }, { text: `**${title}**`, mimeType: "text/markdown" });
 */
export function withLlmContent(
	content: string,
	metadata: Record<string, unknown>,
	display: SenseDisplayBlock,
): Record<string, unknown> {
	return { ...metadata, content, _display: display };
}

export function getString(payload: Record<string, unknown>, key: string): string | undefined {
	const v = payload[key];
	return typeof v === "string" ? v : undefined;
}

export function getNumber(payload: Record<string, unknown>, key: string): number | undefined {
	const v = payload[key];
	return typeof v === "number" ? v : undefined;
}

export function getBoolean(payload: Record<string, unknown>, key: string): boolean | undefined {
	const v = payload[key];
	return typeof v === "boolean" ? v : undefined;
}
