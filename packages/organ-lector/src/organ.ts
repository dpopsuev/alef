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

import type { CorpusHandlerCtx, Organ } from "@dpopsuev/alef-spine";
import { defineCorpusOrgan } from "@dpopsuev/alef-spine";
import type { LectorBackend } from "./backend.js";
import { LocalLectorBackend } from "./local-backend.js";

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const READ_TOOL = {
	name: "lector.read",
	description:
		"Read a file and its symbol map. Use symbol= to zoom into a single function/class/type block. " +
		"Always returns all declared symbols regardless of zoom.",
	inputSchema: {
		type: "object",
		properties: {
			path: { type: "string", description: "File path (relative or absolute)" },
			symbol: { type: "string", description: "Name of a symbol to zoom into (returns just that block)" },
			maxLines: { type: "number", description: "Max lines to return (default: 2000 full, 300 symbol)" },
			offset: { type: "number", description: "Start line for full-file reads (1-indexed)" },
		},
		required: ["path"],
	},
} as const;

const WRITE_TOOL = {
	name: "lector.write",
	description: "Write content to a file. Creates parent directories if needed. Overwrites existing content.",
	inputSchema: {
		type: "object",
		properties: {
			path: { type: "string", description: "File path (relative or absolute)" },
			content: { type: "string", description: "Content to write" },
		},
		required: ["path", "content"],
	},
} as const;

const EDIT_TOOL = {
	name: "lector.edit",
	description:
		"Apply targeted text replacements to a file. Each edit must match exactly one location. " +
		"Edits are applied in order. Use lector.read first to get the exact text.",
	inputSchema: {
		type: "object",
		properties: {
			path: { type: "string", description: "File path (relative or absolute)" },
			edits: {
				type: "array",
				description: "Ordered list of replacements",
				items: {
					type: "object",
					properties: {
						oldText: { type: "string", description: "Exact text to replace (must be unique in file)" },
						newText: { type: "string", description: "Replacement text" },
					},
					required: ["oldText", "newText"],
				},
			},
		},
		required: ["path", "edits"],
	},
} as const;

const SEARCH_TOOL = {
	name: "lector.search",
	description:
		"Search file contents with ripgrep (grep fallback). Returns matching lines with file path and line number.",
	inputSchema: {
		type: "object",
		properties: {
			pattern: { type: "string", description: "Search pattern (regex or literal)" },
			path: { type: "string", description: "Directory or file to search (default: cwd)" },
			caseInsensitive: { type: "boolean", description: "Case-insensitive search (default: false)" },
			maxResults: { type: "number", description: "Max matches to return (default: 200)" },
			extension: { type: "string", description: "Filter by file extension, e.g. 'ts'" },
		},
		required: ["pattern"],
	},
} as const;

const FIND_TOOL = {
	name: "lector.find",
	description: "Find files by glob pattern. Use depth=1 to list immediate children of a directory.",
	inputSchema: {
		type: "object",
		properties: {
			glob: { type: "string", description: "Glob pattern, e.g. '*.ts' or '*.test.ts'" },
			path: { type: "string", description: "Root directory to search (default: cwd)" },
			maxResults: { type: "number", description: "Max results (default: 500)" },
			depth: { type: "number", description: "Max directory depth (depth=1 = immediate children)" },
			hidden: { type: "boolean", description: "Include hidden files (default: false)" },
		},
		required: ["glob"],
	},
} as const;

const CALLERS_TOOL = {
	name: "lector.callers",
	description:
		"Find all call sites that reference a symbol by name. " +
		"Phase 1: grep-based (fast, no LSP). Returns file, line, and surrounding context.",
	inputSchema: {
		type: "object",
		properties: {
			symbol: { type: "string", description: "Symbol name to search for" },
			path: { type: "string", description: "Restrict search to this path (default: entire workspace)" },
			maxResults: { type: "number", description: "Max results (default: 100)" },
		},
		required: ["symbol"],
	},
} as const;

// ---------------------------------------------------------------------------
// Organ factory
// ---------------------------------------------------------------------------

export interface LectorOrganOptions {
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
	/** Restrict which tools are mounted (organ ablation). */
	actions?: readonly string[];
}

export function createLectorOrgan(opts: LectorOrganOptions): Organ {
	const backend: LectorBackend =
		opts.backend ??
		new LocalLectorBackend({
			cwd: opts.cwd,
			allowAbsolutePaths: opts.allowAbsolutePaths,
		});

	const base = defineCorpusOrgan(
		"lector",
		{
			"lector.read": {
				tool: READ_TOOL,
				shouldCache: (_ctx, result) => result !== undefined,
				handle: async (ctx: CorpusHandlerCtx) => {
					const path = String(ctx.payload.path ?? "");
					if (!path) throw new Error("lector.read: path is required");
					const symbol = typeof ctx.payload.symbol === "string" ? ctx.payload.symbol : undefined;
					const maxLines = typeof ctx.payload.maxLines === "number" ? ctx.payload.maxLines : undefined;
					const offset = typeof ctx.payload.offset === "number" ? ctx.payload.offset : undefined;
					const r = await backend.read(path, { symbol, maxLines, offset });
					return r as unknown as Record<string, unknown>;
				},
			},

			"lector.write": {
				tool: WRITE_TOOL,
				invalidates: (ctx) => [String(ctx.payload.path ?? "")],
				handle: async (ctx: CorpusHandlerCtx) => {
					const path = String(ctx.payload.path ?? "");
					const content = String(ctx.payload.content ?? "");
					if (!path) throw new Error("lector.write: path is required");
					await backend.write(path, content);
					return { path, written: content.length };
				},
			},

			"lector.edit": {
				tool: EDIT_TOOL,
				invalidates: (ctx) => [String(ctx.payload.path ?? "")],
				handle: async (ctx: CorpusHandlerCtx) => {
					const path = String(ctx.payload.path ?? "");
					if (!path) throw new Error("lector.edit: path is required");
					const rawEdits = Array.isArray(ctx.payload.edits) ? ctx.payload.edits : [];
					const edits = rawEdits.map((e: unknown) => {
						const edit = e as Record<string, unknown>;
						return {
							oldText: String(edit.oldText ?? ""),
							newText: String(edit.newText ?? ""),
						};
					});
					await backend.edit(path, edits);
					return { path, edits: edits.length };
				},
			},

			"lector.search": {
				tool: SEARCH_TOOL,
				shouldCache: (_ctx, result) => result !== undefined,
				handle: async (ctx: CorpusHandlerCtx) => {
					const pattern = String(ctx.payload.pattern ?? "");
					if (!pattern) throw new Error("lector.search: pattern is required");
					const matches = await backend.search(pattern, {
						path: typeof ctx.payload.path === "string" ? ctx.payload.path : undefined,
						caseInsensitive: ctx.payload.caseInsensitive === true,
						maxResults: typeof ctx.payload.maxResults === "number" ? ctx.payload.maxResults : undefined,
						extension: typeof ctx.payload.extension === "string" ? ctx.payload.extension : undefined,
					});
					return { matches, count: matches.length };
				},
			},

			"lector.find": {
				tool: FIND_TOOL,
				shouldCache: (_ctx, result) => result !== undefined,
				handle: async (ctx: CorpusHandlerCtx) => {
					const glob = String(ctx.payload.glob ?? "");
					if (!glob) throw new Error("lector.find: glob is required");
					const paths = await backend.find(glob, {
						path: typeof ctx.payload.path === "string" ? ctx.payload.path : undefined,
						maxResults: typeof ctx.payload.maxResults === "number" ? ctx.payload.maxResults : undefined,
						depth: typeof ctx.payload.depth === "number" ? ctx.payload.depth : undefined,
						hidden: ctx.payload.hidden === true,
					});
					return { paths, count: paths.length };
				},
			},

			"lector.callers": {
				tool: CALLERS_TOOL,
				shouldCache: (_ctx, result) => result !== undefined,
				handle: async (ctx: CorpusHandlerCtx) => {
					const symbol = String(ctx.payload.symbol ?? "");
					if (!symbol) throw new Error("lector.callers: symbol is required");
					const callers = await backend.callers(symbol, {
						path: typeof ctx.payload.path === "string" ? ctx.payload.path : undefined,
						maxResults: typeof ctx.payload.maxResults === "number" ? ctx.payload.maxResults : undefined,
					});
					return { callers, count: callers.length };
				},
			},
		},
		{ actions: opts.actions, directives: LECTOR_DIRECTIVES },
	);

	// On unmount: clear the backend's block cache if using LocalLectorBackend.
	if (backend instanceof LocalLectorBackend) {
		const originalMount = base.mount.bind(base);
		base.mount = (nerve) => {
			const unmount = originalMount(nerve);
			return () => {
				unmount();
				backend.blockCache.clear();
			};
		};
	}

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
