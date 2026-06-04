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
 *   import { getString, getNumber, getBoolean } from "@dpopsuev/alef-spine";
 *   const path = getString(ctx.payload, "path") ?? "";
 *   const limit = getNumber(ctx.payload, "limit");
 *   const hidden = getBoolean(ctx.payload, "hidden") ?? false;
 */

/**
 * Canonical event type names shared across organs.
 * Defined once here — all packages import from spine rather than redeclaring.
 */
export const DIALOG_MESSAGE = "dialog.message" as const;

/**
 * Canonical payload field names used to extract a human-readable label for
 * a tool call in TUI pills and in the concurrent-ops system prompt injection.
 *
 * Defined once here so pickKeyArg (organ-llm) and keyArgFromPayload (tui)
 * stay in sync automatically. Add new fields when new organs are introduced.
 */
export const KEY_ARG_FIELDS = [
	"command",
	"path",
	"url",
	"pattern",
	"glob",
	"symbol",
	"query",
	"text",
	"code",
	"instruction",
] as const;

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
