import type { Component } from "../component.js";
import { Markdown } from "../components/markdown.js";
import { Text } from "../components/text.js";
import type { ThemeTokens } from "../theme-types.js";
import { fmtMs, sanitizeForDisplay } from "./ansi-utils.js";
import { INDENT } from "./layout-constants.js";
import { makeToolOutputMarkdownTheme } from "./markdown-themes.js";
import { spinnerFrame } from "./spinner.js";
import { bold, color, dim, glyph } from "./theme.js";

const KEY_ARG_FIELDS = ["command", "path", "url", "pattern", "glob", "query", "text", "prompt", "name"] as const;

/**
 *
 */
export function toolActiveLine(name: string, keyArg: string, t: ThemeTokens, elapsedMs = 0, callId?: string): string {
	const elapsed = fmtMs(elapsedMs);
	const spinner = callId ? spinnerFrame(callId, elapsedMs) : color(glyph("state:active"), t.warnFg);
	const label = `${spinner} ${color(name, t.primaryFg)}`;
	const body = keyArg ? `  ${color(keyArg, t.secondaryFg)}` : "";
	const timing = elapsedMs > 0 ? `  ${color(elapsed, t.mutedFg)}` : "";
	const indent = " ".repeat(INDENT.TOOL_LINE);
	return `${indent}${label}${body}${timing}`;
}

/**
 * A live-updating tool call row.
 *
 * While in-flight: re-renders on every TUI frame showing a spinner + live
 * elapsed time (driven by PromptConsole.startThinking's requestRender loop).
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

/**
 *
 */
export function renderToolLine(name: string, keyArg: string, elapsedMs: number, ok: boolean, t: ThemeTokens): string {
	const elapsed = fmtMs(elapsedMs);
	const g = ok ? glyph("state:done") : glyph("state:error");
	const fg = ok ? t.okFg : t.errFg;
	const indent = " ".repeat(INDENT.TOOL_LINE);
	return `${indent}${color(g, fg)} ${color(name, t.primaryFg)}  ${color(keyArg, t.secondaryFg)}  ${color(elapsed, t.mutedFg)}`;
}

/**
 *
 */
export function keyArgFromPayload(args: Record<string, unknown>): string {
	for (const key of KEY_ARG_FIELDS) {
		const v = args[key];
		if (typeof v === "string" && v.length > 0) {
			const firstLine = v.split("\n")[0].trim();
			return firstLine.slice(0, 60);
		}
	}
	return "";
}

/**
 *
 */
export function truncateToolOutput(text: string): string {
	const lines = text.split("\n");
	const capped = lines.length > 20 ? lines.slice(0, 20) : lines;
	let out = capped.join("\n");
	if (out.length > 1000) out = `${out.slice(0, 1000)}\u2026`;
	if (lines.length > 20) out += `\n  [\u2026${lines.length - 20} more lines]`;
	return out;
}

/**
 *
 */
export function renderDiffDisplay(diffText: string, t: ThemeTokens): string {
	const lines = diffText.split("\n");
	return lines
		.map((line, i) => {
			if (i === 0) return bold(line);
			if (line === "") return line;
			if (line.startsWith("+")) return color(line, t.okFg);
			if (line.startsWith("-")) return color(line, t.errFg);
			return dim(line);
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
	return new Markdown(truncateToolOutput(sanitized), INDENT.TOOL_OUTPUT, 0, makeToolOutputMarkdownTheme(t));
}

/**
 *
 */
export function formatCompact(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

/**
 *
 */
export function formatTokenUsage(
	input: number,
	output: number,
	_t: ThemeTokens,
	turnMs?: number,
	sessionTotal?: number,
): string {
	const timing = turnMs !== undefined ? ` · ${(turnMs / 1000).toFixed(1)}s` : "";
	const session =
		sessionTotal !== undefined && sessionTotal > input + output ? ` · ${formatCompact(sessionTotal)} total` : "";
	return color(`${formatCompact(input)} in · ${formatCompact(output)} out${timing}${session}`, _t.mutedFg);
}
