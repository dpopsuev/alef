/**
 * CodeIntelOrgan — EDA adapter for the CodeIntelBackend.
 *
 * Six tools exposed to the LLM:
 *   code.read    — read file + symbol map; optional symbol block zoom
 *   code.write   — write file (creates parents)
 *   code.edit    — targeted edit with unique-match enforcement
 *   code.search  — grep/ripgrep content search
 *   code.find    — glob file find
 *   code.callers — find call sites for a symbol (Phase 1: grep)
 *
 * Cache wiring:
 *   code.read, code.search, code.find, code.callers — shouldCache: true
 *   code.write, code.edit — invalidates: [path] (evicts read + callers cache)
 */

import type { BaseOrganOptions, Organ } from "@dpopsuev/alef-kernel";
import { defineOrgan, typedAction, withDisplay } from "@dpopsuev/alef-kernel";
import { z } from "zod";
import type { LectorBackend } from "./backend.js";
import { LocalLectorBackend } from "./local-backend.js";

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const READ_TOOL = {
	name: "code.read",
	description:
		"Read a code file with its symbol map (functions, classes, types). Use symbol= to zoom into one declaration. " +
		"Always returns all declared symbols. For non-code files, use fs.read instead.",
	inputSchema: z.object({
		path: z.string().min(1).describe("File path (relative or absolute)"),
		symbol: z.string().optional().describe("Name of a symbol to zoom into (returns just that block)"),
		maxLines: z.number().optional().describe("Max lines to return (default: 2000 full, 300 symbol)"),
		offset: z.number().optional().describe("Start line for full-file reads (1-indexed)"),
	}),
};

const WRITE_TOOL = {
	name: "code.write",
	description:
		"Write full content to a code file, creating parent directories if needed. For targeted symbol-level edits, use code.edit instead.",
	inputSchema: z.object({
		path: z.string().min(1).describe("File path (relative or absolute)"),
		content: z.string().min(1).describe("Content to write"),
	}),
};

const EDIT_TOOL = {
	name: "code.edit",
	description:
		"Edit a code file by exact text or by symbol name (replaces the full function/class span). " +
		"Requires code.read first. More precise than fs.edit for code symbols.",
	inputSchema: z.object({
		path: z.string().min(1).describe("File path (relative or absolute)"),
		edits: z
			.array(
				z.object({
					oldText: z.string().optional().describe("Exact text to replace (must be unique in file)"),
					newText: z.string().min(1).describe("Replacement text"),
					symbol: z
						.string()
						.optional()
						.describe(
							"Name of a symbol to replace entirely (function, class, etc.). " +
								"Replaces the full span. Requires prior code.read.",
						),
				}),
			)
			.describe("Ordered list of replacements (each uses oldText or symbol)"),
	}),
};

const SEARCH_TOOL = {
	name: "code.search",
	description:
		"Search file contents by pattern using ripgrep. Returns matching lines with file path and line number. " +
		"To find all callers of a specific symbol by name, use code.callers instead.",
	inputSchema: z.object({
		pattern: z.string().min(1).describe("Search pattern (regex or literal)"),
		path: z.string().optional().describe("Directory or file to search (default: cwd)"),
		caseInsensitive: z.boolean().optional().describe("Case-insensitive search (default: false)"),
		maxResults: z.number().optional().describe("Max matches to return (default: 200)"),
		extension: z.string().optional().describe("Filter by file extension, e.g. 'ts'"),
	}),
};

const FIND_TOOL = {
	name: "code.find",
	description: "Find files by glob pattern. Use depth=1 to list immediate children of a directory.",
	inputSchema: z.object({
		glob: z.string().min(1).describe("Glob pattern, e.g. '*.ts' or '*.test.ts'"),
		path: z.string().optional().describe("Root directory to search (default: cwd)"),
		maxResults: z.number().optional().describe("Max results (default: 500)"),
		depth: z.number().optional().describe("Max directory depth (depth=1 = immediate children)"),
		hidden: z.boolean().optional().describe("Include hidden files (default: false)"),
	}),
};

const CALLERS_TOOL = {
	name: "code.callers",
	description:
		"Find every call site referencing a named symbol (function, class, variable). " +
		"Returns file, line, and surrounding context. Use before refactoring to understand blast radius.",
	inputSchema: z.object({
		symbol: z.string().min(1).describe("Symbol name to search for"),
		path: z.string().optional().describe("Restrict search to this path (default: entire workspace)"),
		maxResults: z.number().optional().describe("Max results (default: 100)"),
	}),
};

// ---------------------------------------------------------------------------
// Organ factory
// ---------------------------------------------------------------------------

export interface CodeIntelOrganOptions extends BaseOrganOptions {
	/**
	 * Workspace root. All relative paths resolve against this.
	 * Required when using the default LocalLectorBackend.
	 */
	cwd: string;
	/** OCAP grant — directories accessible. Undefined = unrestricted. */
	writableRoots?: readonly string[];
	/**
	 * Override the backend (e.g. StubLectorBackend for tests,
	 * DockerLectorBackend for EnclosureOrgan integration).
	 * Default: LocalLectorBackend.
	 */
	backend?: LectorBackend;
}

export function createCodeIntelOrgan(opts: CodeIntelOrganOptions): Organ {
	const backend: LectorBackend =
		opts.backend ??
		new LocalLectorBackend({
			cwd: opts.cwd,
			writableRoots: opts.writableRoots,
		});

	const base = defineOrgan(
		"code-intel",
		{
			motor: {
				"code.read": typedAction(
					READ_TOOL,
					async (ctx) => {
						const { path, symbol, maxLines, offset } = ctx.payload;
						if (!path) throw new Error("code.read: path is required");
						const r = await backend.read(path, { symbol, maxLines, offset });
						const readLabel = symbol ? `Read **${symbol}** in ${path}` : `Read **${path}**`;
						return withDisplay(r as unknown as Record<string, unknown>, {
							text: readLabel,
							mimeType: "text/markdown",
						});
					},
					{ shouldCache: (_ctx, result) => result !== undefined },
				),

				"code.write": typedAction(
					WRITE_TOOL,
					async (ctx) => {
						const { path, content } = ctx.payload;
						if (!path) throw new Error("code.write: path is required");
						await backend.write(path, content);
						return withDisplay(
							{ path, written: content.length },
							{ text: `Wrote **${path}** (${content.length} bytes)`, mimeType: "text/markdown" },
						);
					},
					{ invalidates: (ctx) => [ctx.payload.path] },
				),

				"code.edit": typedAction(
					EDIT_TOOL,
					async (ctx) => {
						const { path, edits } = ctx.payload;
						if (!path) throw new Error("code.edit: path is required");
						await backend.edit(path, edits);
						return withDisplay(
							{ path, edits: edits.length },
							{
								text: `Edited **${path}** (${edits.length} edit${edits.length === 1 ? "" : "s"})`,
								mimeType: "text/markdown",
							},
						);
					},
					{ invalidates: (ctx) => [ctx.payload.path] },
				),

				"code.search": typedAction(
					SEARCH_TOOL,
					async (ctx) => {
						const { pattern, path, caseInsensitive, maxResults, extension } = ctx.payload;
						if (!pattern) throw new Error("code.search: pattern is required");
						const matches = await backend.search(pattern, { path, caseInsensitive, maxResults, extension });
						return withDisplay(
							{ matches, count: matches.length },
							{
								text: `Found ${matches.length} match${matches.length === 1 ? "" : "es"} for \`${pattern}\``,
								mimeType: "text/markdown",
							},
						);
					},
					{ shouldCache: (_ctx, result) => result !== undefined },
				),

				"code.find": typedAction(
					FIND_TOOL,
					async (ctx) => {
						const { glob, path, maxResults, depth, hidden } = ctx.payload;
						if (!glob) throw new Error("code.find: glob is required");
						const paths = await backend.find(glob, { path, maxResults, depth, hidden });
						return withDisplay(
							{ paths, count: paths.length },
							{
								text: `Found ${paths.length} file${paths.length === 1 ? "" : "s"} matching \`${glob}\``,
								mimeType: "text/markdown",
							},
						);
					},
					{ shouldCache: (_ctx, result) => result !== undefined },
				),

				"code.callers": typedAction(
					CALLERS_TOOL,
					async (ctx) => {
						const { symbol, path, maxResults } = ctx.payload;
						if (!symbol) throw new Error("code.callers: symbol is required");
						const callers = await backend.callers(symbol, { path, maxResults });
						return withDisplay(
							{ callers, count: callers.length },
							{
								text: `Found ${callers.length} caller${callers.length === 1 ? "" : "s"} of \`${symbol}\``,
								mimeType: "text/markdown",
							},
						);
					},
					{ shouldCache: (_ctx, result) => result !== undefined },
				),
			},
		},
		{
			actions: opts.actions,
			directives: CODE_INTEL_DIRECTIVES,
			description: "Symbol-aware code reading and editing with LSP caller analysis.",
			labels: ["code", "symbols", "lsp", "read", "edit"],
			ready: backend instanceof LocalLectorBackend ? () => backend.warmUp() : undefined,
			onUnmount:
				backend instanceof LocalLectorBackend
					? () => {
							backend.blockCache.clear();
							void backend.stopLsp();
						}
					: undefined,
		},
	);

	return base;
}

const CODE_INTEL_DIRECTIVES = [
	`**code tool guidance**
- code.read returns file content AND a symbol map on every call. Use symbol= to zoom into a single function or class without reading the whole file.
- Always call code.read before code.edit. Never edit from memory or inference.
- code.edit applies targeted replacements. Each oldText must be unique within the file. Provide enough context to be unambiguous.
- code.write overwrites the entire file. Use it only to create new files or completely replace an existing one.
- code.search searches file contents across the workspace (regex or literal). Prefer this over reading every file individually.
- code.find lists files matching a glob pattern. Use depth=1 to list immediate children of a directory.
- code.callers finds all call sites of a named symbol. Use it before refactoring to understand blast radius.
- All paths must resolve within the working directory.`,
];
