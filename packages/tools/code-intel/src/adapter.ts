/**
 * CodeIntelAdapter — LSP-based code intelligence for TypeScript/JavaScript.
 *
 * Four LSP-powered tools for code navigation and analysis:
 *   code.symbols  — workspace-wide symbol search (functions, classes, interfaces, types)
 *   code.hover    — type information and documentation at a position
 *   code.callers  — find all call sites of a symbol (LSP + grep fallback)
 *   code.diagnose — get TypeScript compilation errors for a file
 *
 * Design: Pure code intelligence layer. Use fs.* tools for file operations.
 * This adapter focuses solely on LSP capabilities that fs cannot provide.
 */

import type { Adapter, BaseAdapterOptions } from "@dpopsuev/alef-kernel/adapter";
import { defineAdapter, typedAction } from "@dpopsuev/alef-kernel/adapter";
import { withDisplay } from "@dpopsuev/alef-kernel/payload";
import { z } from "zod";
import type { CodeIntelBackend, Diagnostic } from "./backend.js";
import { LocalCodeIntelBackend } from "./local-backend.js";

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
}

export function createCodeIntelAdapter(opts: CodeIntelAdapterOptions): Adapter {
	const backend: CodeIntelBackend =
		opts.backend ??
		new LocalCodeIntelBackend({
			cwd: opts.cwd,
			writableRoots: opts.writableRoots,
		});

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
			},
		},
		{
			actions: opts.actions,
			directives: CODE_INTEL_DIRECTIVES,
			description: "LSP-based code intelligence: workspace symbols, type info, call hierarchy, diagnostics.",
			labels: ["code", "lsp", "typescript", "intelligence", "experimental"],
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
			onUnmount: backend instanceof LocalCodeIntelBackend ? () => backend.stopLsp() : undefined,
		},
	);

	return base;
}

const CODE_INTEL_DIRECTIVES = [
	`**code-intel tool guidance**
- Use fs.read, fs.write, and fs.edit for all file operations. The code-intel adapter provides LSP-based enhancements only.
- code.symbols searches for functions, classes, interfaces, and types across the entire workspace. Use this to find definitions without knowing the file location.
- code.hover provides type information and JSDoc documentation at a specific position. Use this to understand complex TypeScript types.
- code.callers finds all call sites of a named symbol. Use it before refactoring to understand the blast radius of changes.
- code.diagnose checks for TypeScript compilation errors in a file. Use this after editing TS files to verify they compile correctly.
- All code-intel tools work best on TypeScript files. Some tools (hover, diagnose) are TypeScript-only.`,
];
