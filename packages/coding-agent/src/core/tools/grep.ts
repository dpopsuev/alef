import type { AgentTool } from "@dpopsuev/alef-agent-core";
import type { ToolResultCache } from "@dpopsuev/alef-organ-fs";
import {
	DEFAULT_GREP_LIMIT,
	DEFAULT_MAX_BYTES,
	executeGrepQuery,
	type GrepOperations as FsGrepOperations,
	formatSize,
	GREP_MAX_LINE_LENGTH,
} from "@dpopsuev/alef-organ-fs";
import { Text } from "@dpopsuev/alef-tui";
import { type Static, Type } from "typebox";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.js";
import { ensureTool } from "../../utils/tools-manager.js";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.js";
import { getTextOutput, invalidArgText, shortenPath, str } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import type { TruncationResult } from "./truncate.js";

const grepSchema = Type.Object({
	pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
	path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
	glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
	literal: Type.Optional(
		Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" }),
	),
	context: Type.Optional(
		Type.Number({ description: "Number of lines to show before and after each match (default: 0)" }),
	),
	limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 100)" })),
	type: Type.Optional(
		Type.String({ description: "Filter by file type, e.g. 'ts', 'go', 'py', 'js', 'rust' (ripgrep --type)" }),
	),
	filesWithMatches: Type.Optional(
		Type.Boolean({ description: "Return only file paths containing matches, no line content (ripgrep -l)" }),
	),
	countOnly: Type.Optional(
		Type.Boolean({ description: "Return match count per file instead of content (ripgrep --count)" }),
	),
});

export type GrepToolInput = Static<typeof grepSchema>;
export type GrepOperations = FsGrepOperations;

export interface GrepToolDetails {
	truncation?: TruncationResult;
	matchLimitReached?: number;
	linesTruncated?: boolean;
	cache?: {
		hit: boolean;
		ageMs?: number;
		ttlMs?: number;
	};
}

interface GrepToolResponse {
	content: Array<{ type: "text"; text: string }>;
	details: GrepToolDetails | undefined;
}

export interface GrepToolOptions {
	/** Custom operations for grep. Default: local filesystem plus ripgrep */
	operations?: GrepOperations;
	/** Optional in-memory cache for repeated grep queries */
	cache?: ToolResultCache;
}

function formatGrepCall(
	args: { pattern: string; path?: string; glob?: string; limit?: number } | undefined,
	theme: typeof import("../../modes/interactive/theme/theme.js").theme,
): string {
	const pattern = str(args?.pattern);
	const rawPath = str(args?.path);
	const path = rawPath !== null ? shortenPath(rawPath || ".") : null;
	const glob = str(args?.glob);
	const limit = args?.limit;
	const invalidArg = invalidArgText(theme);
	let text =
		theme.fg("toolTitle", theme.bold("file_grep")) +
		" " +
		(pattern === null ? invalidArg : theme.fg("accent", `/${pattern || ""}/`)) +
		theme.fg("toolOutput", ` in ${path === null ? invalidArg : path}`);
	if (glob) {
		text += theme.fg("toolOutput", ` (${glob})`);
	}
	if (limit !== undefined) {
		text += theme.fg("toolOutput", ` limit ${limit}`);
	}
	return text;
}

function formatGrepResult(
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: GrepToolDetails;
	},
	options: ToolRenderResultOptions,
	theme: typeof import("../../modes/interactive/theme/theme.js").theme,
	showImages: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	let text = "";
	if (output) {
		const lines = output.split("\n");
		const maxLines = options.expanded ? lines.length : 15;
		const displayLines = lines.slice(0, maxLines);
		const remaining = lines.length - maxLines;
		text += `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")})`;
		}
	}

	const matchLimit = result.details?.matchLimitReached;
	const truncation = result.details?.truncation;
	const linesTruncated = result.details?.linesTruncated;
	if (matchLimit || truncation?.truncated || linesTruncated) {
		const warnings: string[] = [];
		if (matchLimit) {
			warnings.push(`${matchLimit} matches limit`);
		}
		if (truncation?.truncated) {
			warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
		}
		if (linesTruncated) {
			warnings.push("some lines truncated");
		}
		text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
	}
	return text;
}

export function createGrepToolDefinition(
	cwd: string,
	options?: GrepToolOptions,
): ToolDefinition<typeof grepSchema, GrepToolDetails | undefined> {
	const customOps = options?.operations;
	const cache = options?.cache;
	return {
		name: "file_grep",
		label: "file_grep",
		description: `Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to ${DEFAULT_GREP_LIMIT} matches or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars. Use type='ts' to restrict to a file type, filesWithMatches=true to get only filenames, countOnly=true for match counts, literal=true to disable regex, context=N for surrounding lines.`,
		promptSnippet: "Search file contents for patterns (respects .gitignore)",
		parameters: grepSchema,
		async execute(
			_toolCallId,
			{
				pattern,
				path: searchDir,
				glob,
				ignoreCase,
				literal,
				context,
				limit,
				type,
				filesWithMatches,
				countOnly,
			}: {
				pattern: string;
				path?: string;
				glob?: string;
				ignoreCase?: boolean;
				literal?: boolean;
				context?: number;
				limit?: number;
				type?: string;
				filesWithMatches?: boolean;
				countOnly?: boolean;
			},
			signal?: AbortSignal,
			_onUpdate?,
			_ctx?,
		) {
			const response = await executeGrepQuery(
				{
					pattern,
					path: searchDir,
					glob,
					ignoreCase,
					literal,
					context,
					limit,
					type,
					filesWithMatches,
					countOnly,
				},
				{
					cwd,
					operations: customOps,
					cache,
					signal,
					resolveRgPath: () => ensureTool("rg", true),
				},
			);
			return response as GrepToolResponse;
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatGrepCall(args, theme));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatGrepResult(result as any, options, theme, context.showImages));
			return text;
		},
	};
}

export function createGrepTool(cwd: string, options?: GrepToolOptions): AgentTool<typeof grepSchema> {
	return wrapToolDefinition(createGrepToolDefinition(cwd, options));
}
