/**
 * Tool call rendering helpers — lines, output snippets, diff display.
 *
 * Single responsibility: turn ToolCallStart/End events + display payloads
 * into ANSI-formatted strings and TUI components.
 */

import type { Component } from "@dpopsuev/alef-tui";
import { Markdown, Text } from "@dpopsuev/alef-tui";
import type { ThemeTokens } from "../theme.js";
import { sanitizeForDisplay } from "./ansi-utils.js";
import { INDENT } from "./layout-constants.js";
import { makeToolOutputMarkdownTheme } from "./markdown-themes.js";
import { color, dim, glyph } from "./theme.js";

/** Raw ANSI for diff rendering (chalk silences itself outside TTY). */
const ANSI_BOLD = "\x1b[1m";
const ANSI_DIM = "\x1b[2m";
const ANSI_RESET = "\x1b[0m";

/** Spinner line shown while a tool call is in-flight. */
export function toolActiveLine(name: string, keyArg: string, t: ThemeTokens, elapsedMs = 0): string {
	const elapsed = elapsedMs >= 1000 ? `${(elapsedMs / 1000).toFixed(1)}s` : `${elapsedMs}ms`;
	const label = `${color(glyph("state:active"), t.warnFg)} ${color(name, t.toolNameFg)}`;
	const body = keyArg ? `  ${color(keyArg, t.toolArgFg)}` : "";
	const timing = elapsedMs > 0 ? `  ${color(elapsed, t.timeFg)}` : "";
	const indent = " ".repeat(INDENT.TOOL_LINE);
	return `${indent}${label}${body}${timing}`;
}

/**
 * A live-updating tool call row.
 *
 * While in-flight: re-renders on every TUI frame showing a spinner + live
 * elapsed time (driven by ConsoleZone.startThinking's requestRender loop).
 * After seal(): renders the static completed line — no more Date.now() calls.
 */
export class ToolCallRow implements Component {
	private startedAt: number;
	private doneElapsedMs = 0;
	private doneOk = false;
	private sealed = false;

	constructor(
		readonly name: string,
		readonly keyArg: string,
		private readonly t: ThemeTokens,
	) {
		this.startedAt = Date.now();
	}

	render(_width: number): string[] {
		if (this.sealed) {
			return [renderToolLine(this.name, this.keyArg, this.doneElapsedMs, this.doneOk, this.t)];
		}
		return [toolActiveLine(this.name, this.keyArg, this.t, Date.now() - this.startedAt)];
	}

	invalidate(): void {}

	/** Transition to completed state. */
	seal(elapsedMs: number, ok: boolean): void {
		this.doneElapsedMs = elapsedMs;
		this.doneOk = ok;
		this.sealed = true;
	}
}

/** Completed tool call line with elapsed time and ok/err glyph. */
export function renderToolLine(name: string, keyArg: string, elapsedMs: number, ok: boolean, t: ThemeTokens): string {
	const elapsed = elapsedMs >= 1000 ? `${(elapsedMs / 1000).toFixed(1)}s` : `${elapsedMs}ms`;
	const g = ok ? glyph("state:done") : glyph("state:error");
	const fg = ok ? t.toolOkFg : t.toolErrFg;
	const indent = " ".repeat(INDENT.TOOL_LINE);
	return `${indent}${color(g, fg)} ${color(name, t.toolNameFg)}  ${color(keyArg, t.toolArgFg)}  ${color(elapsed, t.timeFg)}`;
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
export function renderDiffDisplay(diffText: string, t: ThemeTokens): string {
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
 *
 * Applies sanitization to strip ANSI codes from tool output (e.g. shell.exec
 * capturing colored terminal output) to prevent literal \x1b[1m in the TUI.
 */
export function makeToolOutputComponent(
	snippet: string,
	displayKind: string | undefined,
	t: ThemeTokens,
): Text | Markdown {
	// Sanitize display text — strip ANSI codes that might have leaked from shell/log output.
	const sanitized = sanitizeForDisplay(snippet);

	if (displayKind === "text/x-diff") {
		// Diff rendering applies its own ANSI colors, so we use the sanitized text.
		return new Text(renderDiffDisplay(sanitized, t), INDENT.TOOL_OUTPUT, 0);
	}
	// Markdown rendering for plain text output.
	return new Markdown(truncateToolOutput(sanitized), INDENT.TOOL_OUTPUT, 0, makeToolOutputMarkdownTheme());
}

/** Format token usage footer: "7 in · 1.0k out" */
export function formatTokenUsage(input: number, output: number, _t: ThemeTokens): string {
	function compact(n: number): string {
		if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
		if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
		return String(n);
	}
	return dim(`${compact(input)} in · ${compact(output)} out`);
}
