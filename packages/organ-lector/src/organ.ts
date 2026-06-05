/**
 * LectorOrgan — EDA adapter for the LectorBackend.
 *
 * Six tools exposed to the LLM:
 *   lector.read    — read file + symbol map; optional symbol block zoom
 *   lector.write   — write file (creates parents)
 *   lector.edit    — targeted edit with unique-match enforcement
 *   lector.search  — grep/ripgrep content search
 *   lector.find    — glob file find
 *   lector.callers — find call sites for a symbol (Phase 1: grep)
 *
 * Cache wiring:
 *   lector.read, lector.search, lector.find, lector.callers — shouldCache: true
 *   lector.write, lector.edit — invalidates: [path] (evicts read + callers cache)
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
	name: "lector.read",
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
	name: "lector.write",
	description:
		"Write full content to a code file, creating parent directories if needed. For targeted symbol-level edits, use lector.edit instead.",
	inputSchema: z.object({
		path: z.string().min(1).describe("File path (relative or absolute)"),
		content: z.string().min(1).describe("Content to write"),
	}),
};

const EDIT_TOOL = {
	name: "lector.edit",
	description:
		"Edit a code file by exact text or by symbol name (replaces the full function/class span). " +
		"Requires lector.read first. More precise than fs.edit for code symbols.",
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
								"Replaces the full span. Requires prior lector.read.",
						),
				}),
			)
			.describe("Ordered list of replacements (each uses oldText or symbol)"),
	}),
};

const SEARCH_TOOL = {
	name: "lector.search",
	description:
		"Search file contents by pattern using ripgrep. Returns matching lines with file path and line number. " +
		"To find all callers of a specific symbol by name, use lector.callers instead.",
	inputSchema: z.object({
		pattern: z.string().min(1).describe("Search pattern (regex or literal)"),
		path: z.string().optional().describe("Directory or file to search (default: cwd)"),
		caseInsensitive: z.boolean().optional().describe("Case-insensitive search (default: false)"),
		maxResults: z.number().optional().describe("Max matches to return (default: 200)"),
		extension: z.string().optional().describe("Filter by file extension, e.g. 'ts'"),
	}),
};

const FIND_TOOL = {
	name: "lector.find",
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
	name: "lector.callers",
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

export interface LectorOrganOptions extends BaseOrganOptions {
	/**
	 * Workspace root. All relative paths resolve against this.
	 * Required when using the default LocalLectorBackend.
	 */
	cwd: string;
	/** Allow paths outside cwd. Default: false. */
	allowAbsolutePaths?: boolean;
	/**
	 * Override the backend (e.g. StubLectorBackend for tests,
	 * DockerLectorBackend for EnclosureOrgan integration).
	 * Default: LocalLectorBackend.
	 */
	backend?: LectorBackend;
}

export function createLectorOrgan(opts: LectorOrganOptions): Organ {
	const backend: LectorBackend =
		opts.backend ??
		new LocalLectorBackend({
			cwd: opts.cwd,
			allowAbsolutePaths: opts.allowAbsolutePaths,
		});

	const base = defineOrgan(
		"lector",
		{
			"motor/lector.read": typedAction(
				READ_TOOL,
				async (ctx) => {
					const { path, symbol, maxLines, offset } = ctx.payload;
					if (!path) throw new Error("lector.read: path is required");
					const r = await backend.read(path, { symbol, maxLines, offset });
					const readLabel = symbol ? `Read **${symbol}** in ${path}` : `Read **${path}**`;
					return withDisplay(r as unknown as Record<string, unknown>, {
						text: readLabel,
						mimeType: "text/markdown",
					});
				},
				{ shouldCache: (_ctx, result) => result !== undefined },
			),

			"motor/lector.write": typedAction(
				WRITE_TOOL,
				async (ctx) => {
					const { path, content } = ctx.payload;
					if (!path) throw new Error("lector.write: path is required");
					await backend.write(path, content);
					return withDisplay(
						{ path, written: content.length },
						{ text: `Wrote **${path}** (${content.length} bytes)`, mimeType: "text/markdown" },
					);
				},
				{ invalidates: (ctx) => [ctx.payload.path] },
			),

			"motor/lector.edit": typedAction(
				EDIT_TOOL,
				async (ctx) => {
					const { path, edits } = ctx.payload;
					if (!path) throw new Error("lector.edit: path is required");
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

			"motor/lector.search": typedAction(
				SEARCH_TOOL,
				async (ctx) => {
					const { pattern, path, caseInsensitive, maxResults, extension } = ctx.payload;
					if (!pattern) throw new Error("lector.search: pattern is required");
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

			"motor/lector.find": typedAction(
				FIND_TOOL,
				async (ctx) => {
					const { glob, path, maxResults, depth, hidden } = ctx.payload;
					if (!glob) throw new Error("lector.find: glob is required");
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

			"motor/lector.callers": typedAction(
				CALLERS_TOOL,
				async (ctx) => {
					const { symbol, path, maxResults } = ctx.payload;
					if (!symbol) throw new Error("lector.callers: symbol is required");
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
		{
			actions: opts.actions,
			directives: LECTOR_DIRECTIVES,
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

const LECTOR_DIRECTIVES = [
	`**lector tool guidance**
- lector.read returns file content AND a symbol map on every call. Use symbol= to zoom into a single function or class without reading the whole file.
- Always call lector.read before lector.edit. Never edit from memory or inference.
- lector.edit applies targeted replacements. Each oldText must be unique within the file. Provide enough context to be unambiguous.
- lector.write overwrites the entire file. Use it only to create new files or completely replace an existing one.
- lector.search searches file contents across the workspace (regex or literal). Prefer this over reading every file individually.
- lector.find lists files matching a glob pattern. Use depth=1 to list immediate children of a directory.
- lector.callers finds all call sites of a named symbol. Use it before refactoring to understand blast radius.
- All paths must resolve within the working directory.`,
];
