import type { AgentTool } from "@dpopsuev/alef-agent-core";
import type { ToolResultCache } from "@dpopsuev/alef-organ-fs";
import {
	DEFAULT_FIND_LIMIT,
	DEFAULT_MAX_BYTES,
	executeFindQuery,
	type FindOperations as FsFindOperations,
	formatSize,
} from "@dpopsuev/alef-organ-fs";
import { Text } from "@dpopsuev/alef-tui";
import { type Static, Type } from "typebox";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.js";
import { ensureTool } from "../../utils/tools-manager.js";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.js";
import { getTextOutput, invalidArgText, shortenPath, str } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import type { TruncationResult } from "./truncate.js";

const findSchema = Type.Object({
	pattern: Type.String({
		description:
			"Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'. Use '*' to list all entries.",
	}),
	path: Type.Optional(Type.String({ description: "Directory to search in (default: current directory)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of results (default: 1000)" })),
	type: Type.Optional(
		Type.Union([Type.Literal("file"), Type.Literal("directory"), Type.Literal("symlink")], {
			description: "Filter by entry type: 'file', 'directory', or 'symlink' (fd -t)",
		}),
	),
	extension: Type.Optional(
		Type.String({
			description:
				"Filter by file extension, e.g. 'ts' or '.ts' (fd -e). Faster than glob for single-extension scans.",
		}),
	),
	depth: Type.Optional(
		Type.Number({
			description:
				"Maximum directory depth to descend (fd --max-depth). Use depth=1 to list only immediate children (replaces file_ls).",
		}),
	),
	hidden: Type.Optional(
		Type.Boolean({
			description: "Include hidden files and directories (default: true). Set false to exclude dotfiles.",
		}),
	),
});

export type FindToolInput = Static<typeof findSchema>;
export type FindOperations = FsFindOperations;

export interface FindToolDetails {
	truncation?: TruncationResult;
	resultLimitReached?: number;
	cache?: {
		hit: boolean;
		ageMs?: number;
		ttlMs?: number;
	};
}

interface FindToolResponse {
	content: Array<{ type: "text"; text: string }>;
	details: FindToolDetails | undefined;
}

export interface FindToolOptions {
	/** Custom operations for find. Default: local filesystem plus fd */
	operations?: FindOperations;
	/** Optional in-memory cache for repeated find queries */
	cache?: ToolResultCache;
	/** When set and the fs organ is mounted, routes find through the organ bus. */
	organBus?: import("@dpopsuev/alef-spine").OrganBus;
}

function formatFindCall(
	args: { pattern: string; path?: string; limit?: number } | undefined,
	theme: typeof import("../../modes/interactive/theme/theme.js").theme,
): string {
	const pattern = str(args?.pattern);
	const rawPath = str(args?.path);
	const path = rawPath !== null ? shortenPath(rawPath || ".") : null;
	const limit = args?.limit;
	const invalidArg = invalidArgText(theme);
	let text =
		theme.fg("toolTitle", theme.bold("file_find")) +
		" " +
		(pattern === null ? invalidArg : theme.fg("accent", pattern || "")) +
		theme.fg("toolOutput", ` in ${path === null ? invalidArg : path}`);
	if (limit !== undefined) {
		text += theme.fg("toolOutput", ` (limit ${limit})`);
	}
	return text;
}

function formatFindResult(
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: FindToolDetails;
	},
	options: ToolRenderResultOptions,
	theme: typeof import("../../modes/interactive/theme/theme.js").theme,
	showImages: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	let text = "";
	if (output) {
		const lines = output.split("\n");
		const maxLines = options.expanded ? lines.length : 20;
		const displayLines = lines.slice(0, maxLines);
		const remaining = lines.length - maxLines;
		text += `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")})`;
		}
	}

	const resultLimit = result.details?.resultLimitReached;
	const truncation = result.details?.truncation;
	if (resultLimit || truncation?.truncated) {
		const warnings: string[] = [];
		if (resultLimit) warnings.push(`${resultLimit} results limit`);
		if (truncation?.truncated) warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
		text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
	}
	return text;
}

export function createFindToolDefinition(
	cwd: string,
	options?: FindToolOptions,
): ToolDefinition<typeof findSchema, FindToolDetails | undefined> {
	const customOps = options?.operations;
	const cache = options?.cache;
	const organBus = options?.organBus;
	return {
		name: "file_find",
		label: "file_find",
		description: `Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to ${DEFAULT_FIND_LIMIT} results or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use type='directory' to find dirs, extension='ts' for fast single-extension scans, depth=1 to list immediate children (replaces ls), hidden=false to exclude dotfiles.`,
		promptSnippet: "Find files by glob pattern (respects .gitignore; depth=1 lists directory contents)",
		parameters: findSchema,
		async execute(
			_toolCallId,
			{
				pattern,
				path: searchDir,
				limit,
				type,
				extension,
				depth,
				hidden,
			}: {
				pattern: string;
				path?: string;
				limit?: number;
				type?: "file" | "directory" | "symlink";
				extension?: string;
				depth?: number;
				hidden?: boolean;
			},
			signal?: AbortSignal,
			_onUpdate?,
			_ctx?,
		) {
			if (organBus?.isMounted("fs")) {
				const busResult = await organBus.invoke("fs", "find", {
					pattern,
					path: searchDir,
					limit,
					type,
					extension,
					depth,
					hidden,
				});
				if (!busResult.ok) {
					return {
						content: [{ type: "text" as const, text: busResult.error ?? "find failed" }],
						isError: true,
						details: undefined,
					};
				}
				return busResult.content as FindToolResponse;
			}
			const response = await executeFindQuery(
				{
					pattern,
					path: searchDir,
					limit,
					type,
					extension,
					depth,
					hidden,
				},
				{
					cwd,
					operations: customOps,
					cache,
					signal,
					resolveFdPath: () => ensureTool("fd", true),
				},
			);
			return response as FindToolResponse;
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatFindCall(args, theme));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatFindResult(result as any, options, theme, context.showImages));
			return text;
		},
	};
}

export function createFindTool(cwd: string, options?: FindToolOptions): AgentTool<typeof findSchema> {
	return wrapToolDefinition(createFindToolDefinition(cwd, options));
}
