/**
 * CodeIntelAdapter — LSP + tree-sitter graph code intelligence.
 *
 * LSP tools: code.symbols, code.hover, code.callers, code.diagnose, code.review
 * AST tools: code.ast.match, code.ast.extract
 * Graph tools: code.index, code.dependencies, code.references, code.impact
 */

import type { Adapter, BaseAdapterOptions } from "@dpopsuev/alef-kernel/adapter";
import { defineAdapter, typedAction } from "@dpopsuev/alef-kernel/adapter";
import { withDisplay } from "@dpopsuev/alef-kernel/payload";
import { z } from "zod";
import type { CodeIntelBackend, Diagnostic } from "./backend.js";
import { LocalCodeIntelBackend } from "./local-backend.js";
import { ASTTools } from "./ast-tools.js";
import { GraphBackend } from "./graph-backend.js";
import { defaultGraphDbPath, WorkspaceIndexer } from "./indexer.js";
import { dirname } from "node:path";
import { toStoredPath, resolveWorkspacePath } from "./path-resolve.js";

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const SYMBOLS_TOOL = {
	name: "code.symbols",
	description:
		"Search for symbols across the entire workspace. Returns functions, classes, interfaces, types, and variables " +
		"matching the query. Useful for finding definitions without knowing the exact file location. " +
		"Query supports fuzzy matching.",
	inputSchema: z.object({
		query: z.string().min(1).describe("Symbol name or pattern to search for (fuzzy match)"),
	}),
};

const HOVER_TOOL = {
	name: "code.hover",
	description:
		"Get type information and documentation for a symbol at a specific position. " +
		"Returns TypeScript type signature, JSDoc comments, and parameter information. " +
		"Use this to understand complex types without reading source files.",
	inputSchema: z.object({
		path: z.string().min(1).describe("File path (relative or absolute)"),
		line: z.number().min(1).describe("Line number (1-indexed)"),
		character: z.number().min(0).describe("Character position (0-indexed)"),
	}),
};

const CALLERS_TOOL = {
	name: "code.callers",
	description:
		"Find every call site referencing a named symbol (function, class, variable). " +
		"Returns file, line, and surrounding context. Use before refactoring to understand blast radius. " +
		"For TypeScript files, uses LSP for precise results. Falls back to grep for other languages.",
	inputSchema: z.object({
		symbol: z.string().min(1).describe("Symbol name to search for"),
		path: z.string().optional().describe("Restrict search to this path (default: entire workspace)"),
		maxResults: z.number().optional().describe("Max results (default: 100)"),
	}),
};

const DIAGNOSE_TOOL = {
	name: "code.diagnose",
	description:
		"Get TypeScript compilation errors and warnings for a file. " +
		"Returns diagnostics with severity (error/warning/info), message, line, and character position. " +
		"Use after editing TypeScript files to verify changes compile correctly.",
	inputSchema: z.object({
		path: z.string().min(1).describe("File path (relative or absolute)"),
	}),
};

const REVIEW_TOOL = {
	name: "code.review",
	description:
		"Review a git diff for correctness bugs. Returns structured annotations with file, line, summary, " +
		"and confidence. Use before committing to catch regressions. " +
		"Pass range (e.g. 'HEAD~1', 'main..HEAD') or omit for working tree diff.",
	inputSchema: z.object({
		range: z.string().optional().describe("Git diff range (default: working tree)"),
		path: z.string().optional().describe("Restrict review to this path"),
	}),
};

export const ANNOTATION_SCHEMA = z.object({
	filePath: z.string(),
	line: z.number(),
	summary: z.string(),
	rationale: z.string().optional(),
	confidence: z.enum(["low", "medium", "high"]).optional(),
	tags: z.array(z.string()).optional(),
});

const AST_MATCH_TOOL = {
	name: "code.ast.match",
	description:
		"Search for symbols by pattern using AST-based matching. Supports wildcards (*) and filters by symbol kind. " +
		"Returns structured matches with file location and confidence scores. Use for finding functions, classes, or types by name pattern.",
	inputSchema: z.object({
		pattern: z.string().min(1).describe("Symbol name pattern (supports * wildcard, e.g. 'calc*')"),
		path: z.string().optional().describe("File or directory to search (default: workspace)"),
		kind: z.string().optional().describe("Filter by symbol kind: function, class, interface, type, const, variable"),
		maxResults: z.number().optional().describe("Maximum results to return (default: 100)"),
	}),
};

const AST_EXTRACT_TOOL = {
	name: "code.ast.extract",
	description:
		"Extract full definition of a symbol from a file including its AST structure. " +
		"Returns the complete function/class/interface body with source text. Use to get implementation details without reading entire files.",
	inputSchema: z.object({
		symbol: z.string().min(1).describe("Symbol name to extract"),
		path: z.string().min(1).describe("File path containing the symbol"),
		kind: z.string().optional().describe("Symbol kind filter: function, class, interface, type"),
	}),
};

const INDEX_TOOL = {
	name: "code.index",
	description:
		"Build or refresh the workspace code graph (tree-sitter → SQLite). " +
		"Indexes symbols, imports, calls, and references. Call before code.dependencies / code.references / code.impact, " +
		"or after large edits. Incremental — only re-parses changed files.",
	inputSchema: z.object({
		path: z.string().optional().describe("Directory or file to index (default: workspace root)"),
	}),
};

const DEPENDENCIES_TOOL = {
	name: "code.dependencies",
	description:
		"Get module dependencies for a file from the code graph. Returns import paths, resolved file locations, and external package flags. " +
		"Auto-indexes the workspace on first use. Prefer code.index after bulk edits.",
	inputSchema: z.object({
		path: z.string().min(1).describe("File path to analyze"),
	}),
};

const REFERENCES_TOOL = {
	name: "code.references",
	description:
		"Find all references to a symbol in the code graph. Returns file, line, column, and context for each reference. " +
		"More comprehensive than code.callers for indexed files — includes reads, writes, type annotations, and imports.",
	inputSchema: z.object({
		symbol: z.string().min(1).describe("Symbol name to find references for"),
		path: z.string().optional().describe("Restrict to symbol defined in this file"),
		maxResults: z.number().optional().describe("Maximum results to return (default: 500)"),
	}),
};

const IMPACT_TOOL = {
	name: "code.impact",
	description:
		"Analyze blast radius for changing a file using the code graph. Returns dependent files and affected symbols with caller counts. " +
		"Use before refactoring to understand downstream impact.",
	inputSchema: z.object({
		path: z.string().min(1).describe("File path to analyze"),
	}),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 *
 */
function formatDiagnostics(diagnostics: Diagnostic[]): string {
	if (diagnostics.length === 0) return "✓ No errors or warnings";

	const severityLabel = (s: number) => {
		if (s === 1) return "ERROR";
		if (s === 2) return "WARN";
		if (s === 3) return "INFO";
		return "HINT";
	};

	const lines = diagnostics.map((d) => `${severityLabel(d.severity)} [${d.line}:${d.character}] ${d.message}`);

	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

/**
 *
 */
export interface CodeIntelAdapterOptions extends BaseAdapterOptions {
	/**
	 * Workspace root. All relative paths resolve against this.
	 * Required when using the default LocalCodeIntelBackend.
	 */
	cwd: string;
	/** OCAP grant — directories accessible. Undefined = unrestricted. */
	writableRoots?: readonly string[];
	/**
	 * Override the backend (e.g. StubCodeIntelBackend for tests,
	 * DockerCodeIntelBackend for EnclosureAdapter integration).
	 * Default: LocalCodeIntelBackend.
	 */
	backend?: CodeIntelBackend;
	/** Override graph DB path (tests). Default: `$XDG_CACHE_HOME/alef/code-intel/<cwd-hash>/graph.db`. */
	graphDbPath?: string;
}

/**
 *
 */
export function createCodeIntelAdapter(opts: CodeIntelAdapterOptions): Adapter {
	const backend: CodeIntelBackend =
		opts.backend ??
		new LocalCodeIntelBackend({
			cwd: opts.cwd,
			writableRoots: opts.writableRoots,
		});

	const astTools = new ASTTools(opts.cwd);
	const graphDbPath = opts.graphDbPath ?? defaultGraphDbPath(opts.cwd);
	const graphBackend = new GraphBackend({ dbPath: graphDbPath });
	const indexer = new WorkspaceIndexer({ cwd: opts.cwd, graph: graphBackend });

	const storedPath = (path: string): string =>
		toStoredPath(resolveWorkspacePath(path, opts.cwd), opts.cwd);

	const base = defineAdapter(
		"code-intel",
		{
			command: {
				"code.symbols": typedAction(
					SYMBOLS_TOOL,
					async (ctx) => {
						const { query } = ctx.payload;
						if (!query) throw new Error("code.symbols: query is required");
						const symbols = await backend.workspaceSymbols(query);
						return withDisplay(
							{ symbols, count: symbols.length },
							{
								text: `Found ${symbols.length} symbol${symbols.length === 1 ? "" : "s"} matching \`${query}\``,
								mimeType: "text/markdown",
							},
						);
					},
					{ shouldCache: () => true },
				),

				"code.hover": typedAction(
					HOVER_TOOL,
					async (ctx) => {
						const { path, line, character } = ctx.payload;
						if (!path) throw new Error("code.hover: path is required");
						const hover = await backend.getHover(path, line, character);
						if (!hover) {
							return withDisplay(
								{ hover: null },
								{ text: "No hover information available", mimeType: "text/markdown" },
							);
						}
						return withDisplay(
							{ type: hover.contents, range: hover.range },
							{ text: `Type info:\n\`\`\`\n${hover.contents}\n\`\`\``, mimeType: "text/markdown" },
						);
					},
					{ shouldCache: () => true },
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
					{ shouldCache: () => true },
				),

				"code.diagnose": typedAction(
					DIAGNOSE_TOOL,
					async (ctx) => {
						const { path } = ctx.payload;
						if (!path) throw new Error("code.diagnose: path is required");
						const diagnostics = await backend.getDiagnostics(path);
						const formatted = formatDiagnostics(diagnostics);
						const summary =
							diagnostics.length === 0
								? `**${path}** - no errors or warnings`
								: `**${path}** - ${diagnostics.length} diagnostic${diagnostics.length === 1 ? "" : "s"}`;

						return withDisplay(
							{ path, diagnostics, count: diagnostics.length },
							{
								text: `${summary}\n\n\`\`\`\n${formatted}\n\`\`\``,
								mimeType: "text/markdown",
							},
						);
					},
					{ shouldCache: () => true },
				),

				"code.review": typedAction(REVIEW_TOOL, async (ctx) => {
					const { range, path } = ctx.payload;
					const args = ["diff", "--no-color"];
					if (range) args.push(range);
					if (path) args.push("--", path);
					const { execSync } = await import("node:child_process");
					let diff: string;
					try {
						diff = execSync(`git ${args.join(" ")}`, {
							cwd: opts.cwd,
							encoding: "utf-8",
							maxBuffer: 1024 * 1024,
						});
					} catch {
						diff = "";
					}
					if (!diff.trim()) {
						return withDisplay(
							{ annotations: [], count: 0 },
							{ text: "No diff to review.", mimeType: "text/plain" },
						);
					}
					return withDisplay(
						{
							diff,
							annotations: [],
							count: 0,
							note: "Diff captured. Use agent.run to spawn a reviewer subagent with this diff as context.",
						},
						{
							text: `Diff captured (${diff.split("\n").length} lines). Spawn a reviewer subagent to analyze.`,
							mimeType: "text/plain",
						},
					);
				}),

				"code.ast.match": typedAction(AST_MATCH_TOOL, async (ctx) => {
					const { pattern, path, kind, maxResults } = ctx.payload;
					const results = await astTools.match({ pattern, path, kind, maxResults });
					return withDisplay(
						{ results, count: results.length },
						{
							text: `Found ${results.length} match${results.length === 1 ? "" : "es"} for pattern \`${pattern}\``,
							mimeType: "text/markdown",
						},
					);
				}),

				"code.ast.extract": typedAction(AST_EXTRACT_TOOL, async (ctx) => {
					const { symbol, path, kind } = ctx.payload;
					const result = await astTools.extract({ symbol, path, kind });
					if (!result) {
						return withDisplay(
							{ symbol, found: false },
							{ text: `Symbol \`${symbol}\` not found in ${path}`, mimeType: "text/markdown" },
						);
					}
					return withDisplay(
						{ symbol: result.symbol, fullText: result.fullText },
						{
							text: `Extracted \`${symbol}\` (${result.symbol.kind}) from ${path}`,
							mimeType: "text/markdown",
						},
					);
				}),

				"code.index": typedAction(INDEX_TOOL, async (ctx) => {
					const { path } = ctx.payload;
					const result = await indexer.ensureIndexed(path);
					return withDisplay(
						{ ...result, dbPath: graphDbPath },
						{
							text: `Indexed ${result.changed} changed file${result.changed === 1 ? "" : "s"} (${result.total} total in graph)`,
							mimeType: "text/markdown",
						},
					);
				}),

				"code.dependencies": typedAction(DEPENDENCIES_TOOL, async (ctx) => {
					const { path } = ctx.payload;
					if (!path) throw new Error("code.dependencies: path is required");
					const key = storedPath(path);
					await indexer.ensureReady(dirname(resolveWorkspacePath(path, opts.cwd)));
					const deps = graphBackend.getDependencies(key);
					return withDisplay(
						{ dependencies: deps, count: deps.length, path: key },
						{
							text: `Found ${deps.length} dependenc${deps.length === 1 ? "y" : "ies"} in \`${key}\``,
							mimeType: "text/markdown",
						},
					);
				}),

				"code.references": typedAction(REFERENCES_TOOL, async (ctx) => {
					const { symbol, path } = ctx.payload;
					if (!symbol) throw new Error("code.references: symbol is required");
					const key = path ? storedPath(path) : undefined;
					await indexer.ensureReady(
						path ? dirname(resolveWorkspacePath(path, opts.cwd)) : undefined,
					);
					const refs = graphBackend.getReferences(symbol, key);
					return withDisplay(
						{ references: refs, count: refs.length },
						{
							text: `Found ${refs.length} reference${refs.length === 1 ? "" : "s"} to \`${symbol}\``,
							mimeType: "text/markdown",
						},
					);
				}),

				"code.impact": typedAction(IMPACT_TOOL, async (ctx) => {
					const { path } = ctx.payload;
					if (!path) throw new Error("code.impact: path is required");
					const key = storedPath(path);
					// Dependents may live anywhere under the workspace — index cwd once.
					await indexer.ensureReady();
					const impact = graphBackend.getImpact(key);
					const summary = `Blast radius for \`${key}\`:\n- ${impact.dependents.length} dependent file${impact.dependents.length === 1 ? "" : "s"}\n- ${impact.affectedSymbols.length} symbol${impact.affectedSymbols.length === 1 ? "" : "s"} with callers`;
					return withDisplay(
						{ ...impact, path: key },
						{
							text: summary,
							mimeType: "text/markdown",
						},
					);
				}),
			},
		},
		{
			actions: opts.actions,
			directives: CODE_INTEL_DIRECTIVES,
			description:
				"Code intelligence: LSP symbols/hover/callers/diagnose plus tree-sitter graph (index, dependencies, references, impact).",
			labels: ["code", "lsp", "typescript", "intelligence", "graph", "experimental"],
			contributions: {
				"event.weights": {
					"code.write": 2.0,
					"code.edit": 2.0,
					"code.read": 1.0,
					"code.callers": 1.0,
					"code.search": 0.6,
					"code.find": 0.6,
				},
			},
			ready: backend instanceof LocalCodeIntelBackend ? () => backend.warmUp() : undefined,
			// eslint-disable-next-line @typescript-eslint/no-misused-promises -- async cleanup is intentional
			onUnmount: async () => {
				if (backend instanceof LocalCodeIntelBackend) {
					await backend.stopLsp();
				}
				graphBackend.close();
			},
		},
	);

	return base;
}

const CODE_INTEL_DIRECTIVES = [
	`**code-intel tool guidance**
- Use fs.read, fs.write, and fs.edit for all file operations. code-intel provides LSP and a local code graph.
- code.symbols / code.hover / code.callers / code.diagnose are LSP-backed (TypeScript).
- code.index builds the tree-sitter → SQLite graph under $XDG_CACHE_HOME/alef/code-intel/. Call it after bulk edits; graph tools auto-index on first use.
- code.dependencies lists imports and resolved local files for a module.
- code.references finds uses of a symbol in the graph (reads, writes, calls, type annotations).
- code.impact shows dependent files and symbols with callers before a refactor.
- code.ast.match / code.ast.extract do structural search without waiting on LSP.`,
];
