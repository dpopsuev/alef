import type { ColorToken } from "../ansi.js";
import type { Component } from "../component.js";
import { Markdown } from "../components/markdown.js";
import type { ThemeTokens } from "../theme-types.js";
import { applyBackgroundToLine, visibleWidth, wrapTextWithAnsi } from "../utils.js";
import { fmtMs, sanitizeForDisplay } from "./ansi-utils.js";
import { INDENT } from "./layout-constants.js";
import { makeToolOutputMarkdownTheme } from "./markdown-themes.js";
import { spinnerFrame } from "./spinner.js";
import { bg, bold, color, dim, glyph } from "./theme.js";
import { pickKeyArg } from "@dpopsuev/alef-kernel/payload";

const DIFF_ADD_BG: ColorToken = { truecolor: "#0d2818", ansi256: 22, ansi16: 42 };
const DIFF_REM_BG: ColorToken = { truecolor: "#2a1215", ansi256: 52, ansi16: 41 };

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
	return pickKeyArg(args);
}

const LONG_ARG_CHARS = 80;

/** Summarize a string arg for the tool header line. Show first line truncated for long values. */
function formatArgValue(value: unknown): string {
	if (typeof value === "string") {
		const firstLine = value.split("\n")[0] ?? value;
		const lineCount = value.split("\n").length;
		if (lineCount > 1) {
			const truncated = firstLine.length > LONG_ARG_CHARS ? `${firstLine.slice(0, LONG_ARG_CHARS)}...` : firstLine;
			return `'${truncated}' +${lineCount - 1} lines`;
		}
		if (value.length > LONG_ARG_CHARS) {
			return `'${value.slice(0, LONG_ARG_CHARS)}...'`;
		}
		return `'${value}'`;
	}
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (value === null || value === undefined) return String(value);
	if (Array.isArray(value)) return `[${value.length} items]`;
	return "{…}";
}

/**
 * Format tool arguments in command-style syntax for namespace.command(param: value) display.
 * Example: (path: 'file.ts', limit: 10)
 * Large / multi-line strings (e.g. fs.write content) are summarized, not inlined.
 */
export function formatToolArgs(args: Record<string, unknown>): string {
	const entries = Object.entries(args);
	if (entries.length === 0) return "";
	const formatted = entries.map(([key, value]) => `${key}: ${formatArgValue(value)}`).join(", ");
	return `(${formatted})`;
}

const FENCE_LINE = /^\s*(`{3,}|~{3,})/;

/** Strip markdown fence marker lines so terminal chrome never paints ``` / ~~~. */
export function stripMarkdownFenceLines(text: string): string {
	const lines = text.split("\n");
	let start = 0;
	let end = lines.length;
	while (start < end && FENCE_LINE.test(lines[start]!)) start++;
	while (end > start && FENCE_LINE.test(lines[end - 1]!)) end--;
	const body = lines.slice(start, end).filter((line) => !FENCE_LINE.test(line));
	return body.join("\n");
}

/** Prefer path/lang header + body for large string args (fs.write content, etc.). */
export function largeTextArgPreview(
	args: Record<string, unknown>,
): { header: string; body: string; lang?: string } | null {
	const path = typeof args.path === "string" ? args.path : undefined;
	const contentKey = (["content", "text", "body", "data"] as const).find(
		(key) => typeof args[key] === "string" && String(args[key]).includes("\n"),
	);
	if (!contentKey) return null;
	const body = String(args[contentKey]);
	const ext = path?.includes(".") ? path.split(".").pop()?.toLowerCase() : undefined;
	const lang =
		ext === "ts" || ext === "tsx"
			? "typescript"
			: ext === "js" || ext === "jsx"
				? "javascript"
				: ext === "py"
					? "python"
					: ext === "sql"
						? "sql"
						: ext === "md"
							? "markdown"
							: ext === "json"
								? "json"
								: ext;
	const header = path ? `${path}${lang ? ` · ${lang}` : ""}` : `${contentKey}${lang ? ` · ${lang}` : ""}`;
	return { header, body, ...(lang ? { lang } : {}) };
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

/** Turn `edit path` + body into Cursor-style `Edited path +N -M`. */
export function formatDiffHeader(firstLine: string, bodyLines: readonly string[]): string {
	const path = firstLine.replace(/^edit\s+/i, "").trim() || firstLine;
	let added = 0;
	let removed = 0;
	for (const line of bodyLines) {
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	const stats = [
		added > 0 ? `+${added}` : null,
		removed > 0 ? `-${removed}` : null,
	]
		.filter((part): part is string => part !== null)
		.join(" ");
	return stats ? `Edited ${path} ${stats}` : `Edited ${path}`;
}

type DiffLineKind = "header" | "add" | "rem" | "ctx" | "blank";

/** Classify a unified-diff source line for coloring / background. */
function classifyDiffLine(line: string, index: number): DiffLineKind {
	if (index === 0) return "header";
	if (line === "") return "blank";
	if (line.startsWith("+")) return "add";
	if (line.startsWith("-")) return "rem";
	return "ctx";
}

/**
 * Color a unified-diff line (fg). Used by DiffBlock and string-level tests.
 * Header becomes Edited path +N -M when the first line is `edit …`.
 */
export function renderDiffDisplay(diffText: string, t: ThemeTokens): string {
	const raw = diffText.split("\n");
	if (raw.length === 0) return "";
	const header = formatDiffHeader(raw[0] ?? "", raw.slice(1));
	const lines = [header, ...raw.slice(1)];
	return lines
		.map((line, i) => {
			const kind = classifyDiffLine(line, i);
			if (kind === "header") return bold(line);
			if (kind === "blank") return line;
			if (kind === "add") return color(line, t.okFg);
			if (kind === "rem") return color(line, t.errFg);
			return dim(line);
		})
		.join("\n");
}

/**
 * Width-aware diff card: soft full-width add/remove backgrounds + Edited header.
 */
export class DiffBlock implements Component {
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		private readonly diffText: string,
		private readonly t: ThemeTokens,
		private readonly paddingX: number = INDENT.TOOL_OUTPUT,
	) {}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const raw = this.diffText.split("\n");
		const header = formatDiffHeader(raw[0] ?? "", raw.slice(1));
		const source = [header, ...raw.slice(1)];
		const contentWidth = Math.max(1, width - this.paddingX);
		const pad = " ".repeat(this.paddingX);
		const out: string[] = [];

		for (let i = 0; i < source.length; i++) {
			const line = source[i] ?? "";
			const kind = classifyDiffLine(line, i);
			const fg =
				kind === "header"
					? bold(line)
					: kind === "add"
						? color(line, this.t.okFg)
						: kind === "rem"
							? color(line, this.t.errFg)
							: kind === "blank"
								? ""
								: dim(line);
			const wrapped = wrapTextWithAnsi(fg, contentWidth);
			const bgToken = kind === "add" ? DIFF_ADD_BG : kind === "rem" ? DIFF_REM_BG : null;
			for (const segment of wrapped.length > 0 ? wrapped : [""]) {
				const withPad = pad + segment;
				if (bgToken) {
					out.push(applyBackgroundToLine(withPad, width, (text) => bg(text, bgToken)));
				} else {
					const visibleLen = visibleWidth(withPad);
					out.push(withPad + " ".repeat(Math.max(0, width - visibleLen)));
				}
			}
		}

		this.cachedWidth = width;
		this.cachedLines = out;
		return out;
	}
}

/**
 * Applies sanitization to strip ANSI codes from tool output (e.g. shell.exec
 * capturing colored terminal output) to prevent literal \x1b[1m in the TUI.
 */
export function makeToolOutputComponent(
	snippet: string,
	displayKind: string | undefined,
	t: ThemeTokens,
): Markdown | DiffBlock {
	const sanitized = stripMarkdownFenceLines(sanitizeForDisplay(snippet));
	if (displayKind === "text/x-diff") {
		return new DiffBlock(sanitized, t, INDENT.TOOL_OUTPUT);
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
