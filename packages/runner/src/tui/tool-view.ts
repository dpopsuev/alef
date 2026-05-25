/**
 * Tool call rendering helpers — lines, output snippets, diff display.
 *
 * Single responsibility: turn ToolCallStart/End events + display payloads
 * into ANSI-formatted strings and TUI components.
 */

import { Markdown, Text } from "@dpopsuev/alef-tui";
import { color, dim, getTheme, glyph } from "../theme.js";
import { makeToolOutputMarkdownTheme } from "./markdown-themes.js";

/** Raw ANSI for diff rendering (chalk silences itself outside TTY). */
const ANSI_BOLD = "\x1b[1m";
const ANSI_DIM = "\x1b[2m";
const ANSI_RESET = "\x1b[0m";

/** Spinner line shown while a tool call is in-flight. */
export function toolActiveLine(name: string, keyArg: string): string {
	const t = getTheme();
	const label = `${color(glyph("state:active"), t.warnFg)} ${color(name, t.toolNameFg)}`;
	const body = keyArg ? `  ${color(keyArg, t.toolArgFg)}` : "";
	return `  ${label}${body}`;
}

/** Completed tool call line with elapsed time and ok/err glyph. */
export function renderToolLine(name: string, keyArg: string, elapsedMs: number, ok: boolean): string {
	const t = getTheme();
	const elapsed = elapsedMs >= 1000 ? `${(elapsedMs / 1000).toFixed(1)}s` : `${elapsedMs}ms`;
	const g = ok ? glyph("state:done") : glyph("state:error");
	const fg = ok ? t.toolOkFg : t.toolErrFg;
	return `  ${color(g, fg)} ${color(name, t.toolNameFg)}  ${color(keyArg, t.toolArgFg)}  ${color(elapsed, t.timeFg)}`;
}

/** Extract the primary key argument from a tool payload for display. */
export function keyArgFromPayload(args: Record<string, unknown>): string {
	for (const key of ["command", "path", "url", "pattern", "glob", "symbol", "query"]) {
		const v = args[key];
		if (typeof v === "string" && v.length > 0) return v.slice(0, 60);
	}
	return "";
}

/** Truncate tool output for inline display: max 20 lines, max 1000 chars. */
export function truncateToolOutput(text: string): string {
	const lines = text.split("\n");
	const capped = lines.length > 20 ? lines.slice(0, 20) : lines;
	let out = capped.join("\n");
	if (out.length > 1000) out = `${out.slice(0, 1000)}\u2026`;
	if (lines.length > 20) out += `\n  [\u2026${lines.length - 20} more lines]`;
	return out;
}

/**
 * Render a text/x-diff display block with ANSI colors.
 * Header line bold, added lines green, removed lines red, context dim.
 */
export function renderDiffDisplay(diffText: string): string {
	const t = getTheme();
	const lines = diffText.split("\n");
	return lines
		.map((line, i) => {
			if (i === 0) return `${ANSI_BOLD}${line}${ANSI_RESET}`;
			if (line === "") return line;
			if (line.startsWith("+")) return color(line, t.toolOkFg);
			if (line.startsWith("-")) return color(line, t.toolErrFg);
			return `${ANSI_DIM}${line}${ANSI_RESET}`;
		})
		.join("\n");
}

/**
 * Build a TUI component for a tool's display output.
 * Returns a Text (diff) or Markdown (plain) node ready to addChild().
 */
export function makeToolOutputComponent(snippet: string, displayKind?: string): Text | Markdown {
	if (displayKind === "text/x-diff") {
		return new Text(renderDiffDisplay(snippet), 3, 0);
	}
	return new Markdown(truncateToolOutput(snippet), 3, 0, makeToolOutputMarkdownTheme());
}

/** Format token usage footer: "7 in · 1.0k out" */
export function formatTokenUsage(input: number, output: number): string {
	function compact(n: number): string {
		if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
		if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
		return String(n);
	}
	return dim(`${compact(input)} in · ${compact(output)} out`);
}
