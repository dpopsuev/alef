import { KEY_ARG_FIELDS } from "@dpopsuev/alef-spine";
import { type Component, Markdown, Text } from "@dpopsuev/alef-tui";
import type { ThemeTokens } from "../theme.js";
import { fmtMs, sanitizeForDisplay } from "./ansi-utils.js";
import { INDENT } from "./layout-constants.js";
import { makeToolOutputMarkdownTheme } from "./markdown-themes.js";
import { color, glyph } from "./theme.js";

/** Raw ANSI for diff rendering (chalk silences itself outside TTY). */
const ANSI_BOLD = "\x1b[1m";
const ANSI_DIM = "\x1b[2m";
const ANSI_RESET = "\x1b[0m";

// ANSI SGR 5 = slow blink; SGR 25 = blink off. Wraps only the circle glyph.
const BLINK_ON = "\x1b[5m";
const BLINK_OFF = "\x1b[25m";

export function toolActiveLine(name: string, keyArg: string, t: ThemeTokens, elapsedMs = 0): string {
	const elapsed = fmtMs(elapsedMs);
	const circle = `${BLINK_ON}${color(glyph("state:active"), t.warnFg)}${BLINK_OFF}`;
	const label = `${circle} ${color(name, t.toolNameFg)}`;
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

	seal(elapsedMs: number, ok: boolean): void {
		this.doneElapsedMs = elapsedMs;
		this.doneOk = ok;
		this.sealed = true;
	}
}

export function renderToolLine(name: string, keyArg: string, elapsedMs: number, ok: boolean, t: ThemeTokens): string {
	const elapsed = fmtMs(elapsedMs);
	const g = ok ? glyph("state:done") : glyph("state:error");
	const fg = ok ? t.toolOkFg : t.toolErrFg;
	const indent = " ".repeat(INDENT.TOOL_LINE);
	return `${indent}${color(g, fg)} ${color(name, t.toolNameFg)}  ${color(keyArg, t.toolArgFg)}  ${color(elapsed, t.timeFg)}`;
}

export function keyArgFromPayload(args: Record<string, unknown>): string {
	for (const key of KEY_ARG_FIELDS) {
		const v = args[key];
		if (typeof v === "string" && v.length > 0) return v.slice(0, 60);
	}
	return "";
}

export function truncateToolOutput(text: string): string {
	const lines = text.split("\n");
	const capped = lines.length > 20 ? lines.slice(0, 20) : lines;
	let out = capped.join("\n");
	if (out.length > 1000) out = `${out.slice(0, 1000)}\u2026`;
	if (lines.length > 20) out += `\n  [\u2026${lines.length - 20} more lines]`;
	return out;
}

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
 * Applies sanitization to strip ANSI codes from tool output (e.g. shell.exec
 * capturing colored terminal output) to prevent literal \x1b[1m in the TUI.
 */
export function makeToolOutputComponent(
	snippet: string,
	displayKind: string | undefined,
	t: ThemeTokens,
): Text | Markdown {
	const sanitized = sanitizeForDisplay(snippet);
	if (displayKind === "text/x-diff") {
		return new Text(renderDiffDisplay(sanitized, t), INDENT.TOOL_OUTPUT, 0);
	}
	return new Markdown(truncateToolOutput(sanitized), INDENT.TOOL_OUTPUT, 0, makeToolOutputMarkdownTheme());
}

export function formatTokenUsage(input: number, output: number, _t: ThemeTokens, turnMs?: number): string {
	function compact(n: number): string {
		if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
		if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
		return String(n);
	}
	const timing = turnMs !== undefined ? ` · ${(turnMs / 1000).toFixed(1)}s` : "";
	return color(`${compact(input)} in · ${compact(output)} out${timing}`, _t.dimFg);
}
