import { constants } from "node:fs";
import { access as fsAccess, readdir as fsReaddir, readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import type { AgentTool } from "@dpopsuev/alef-agent-core";
import type { ToolResultCache } from "@dpopsuev/alef-organ-fs";
import { Text } from "@dpopsuev/alef-tui";
import { type Static, Type } from "typebox";
import ts from "typescript";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.js";
import type { LectorRuntime } from "../lector-runtime.js";
import { resolveToCwd } from "./path-utils.js";
import { invalidArgText, shortenPath, str } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

const TS_JS_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage", ".next", "out", ".turbo"]);
const MAX_OUTPUT_LINES = 400;
const DEFAULT_LIST_LIMIT = 200;
const DEFAULT_DATAFLOW_DEPTH = 4;

interface SymbolNode {
	id: string;
	name: string;
	file: string;
	line: number;
	exported: boolean;
}

interface SymbolEdge {
	fromId: string;
	toId?: string;
	callee: string;
	file: string;
	line: number;
}

interface SymbolGraphSnapshot {
	rootPath: string;
	nodes: SymbolNode[];
	edges: SymbolEdge[];
}

interface SymbolGraphIndex {
	snapshot: SymbolGraphSnapshot;
	nodeById: Map<string, SymbolNode>;
	nodeIdsByName: Map<string, string[]>;
	edgesByCaller: Map<string, SymbolEdge[]>;
	edgesByCallee: Map<string, SymbolEdge[]>;
}

interface RawEdge {
	fromId: string;
	callee: string;
	file: string;
	line: number;
}

/** Optional injected operations for remote or virtual backends. */
export interface SymbolGraphOperations {
	readFile: (absolutePath: string) => Promise<string>;
	readdir: (absolutePath: string) => Promise<string[]>;
	stat: (absolutePath: string) => Promise<{ isDirectory: () => boolean }>;
	access: (absolutePath: string) => Promise<void>;
}

const defaultSymbolGraphOperations: SymbolGraphOperations = {
	readFile: (p) => fsReadFile(p, "utf-8"),
	readdir: (p) => fsReaddir(p),
	stat: (p) => fsStat(p),
	access: (p) => fsAccess(p, constants.R_OK),
};

export interface SymbolGraphToolOptions {
	operations?: SymbolGraphOperations;
	cache?: ToolResultCache;
	queryCache?: ToolResultCache;
	runtime?: LectorRuntime;
}

interface CacheInfo {
	hit: boolean;
	ageMs?: number;
	ttlMs?: number;
}

function makeGraphCacheKey(rootPath: string): string {
	return JSON.stringify({
		v: 1,
		tool: "symbol_graph:index",
		rootPath,
	});
}

function makeQueryCacheKey(toolName: string, payload: Record<string, unknown>): string {
	return JSON.stringify({
		v: 1,
		tool: `${toolName}:query`,
		...payload,
	});
}

function normalizePath(path: string): string {
	return path.replaceAll("\\", "/");
}

function hasExportModifier(node: ts.Node): boolean {
	const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
	if (!modifiers) {
		return false;
	}
	return modifiers.some(
		(modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword || modifier.kind === ts.SyntaxKind.DefaultKeyword,
	);
}

function nodeStartLine(sf: ts.SourceFile, node: ts.Node): number {
	return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function getScriptKind(filePath: string): ts.ScriptKind {
	switch (extname(filePath).toLowerCase()) {
		case ".tsx":
			return ts.ScriptKind.TSX;
		case ".jsx":
			return ts.ScriptKind.JSX;
		case ".ts":
		case ".mts":
		case ".cts":
			return ts.ScriptKind.TS;
		default:
			return ts.ScriptKind.JS;
	}
}

function extractCalleeName(expression: ts.Expression): string | undefined {
	if (ts.isIdentifier(expression)) {
		return expression.text;
	}
	if (ts.isPropertyAccessExpression(expression)) {
		return expression.name.text;
	}
	if (ts.isElementAccessExpression(expression) && ts.isIdentifier(expression.argumentExpression)) {
		return expression.argumentExpression.text;
	}
	return undefined;
}

function appendNameIndex(nameIndex: Map<string, string[]>, key: string, id: string): void {
	const existing = nameIndex.get(key);
	if (existing) {
		if (!existing.includes(id)) {
			existing.push(id);
		}
		return;
	}
	nameIndex.set(key, [id]);
}

function truncateLines(text: string, maxLines: number): { text: string; truncated: boolean } {
	const lines = text.split("\n");
	if (lines.length <= maxLines) {
		return { text, truncated: false };
	}
	return {
		text: `${lines.slice(0, maxLines).join("\n")}\n\n[Truncated: ${lines.length - maxLines} more lines]`,
		truncated: true,
	};
}

async function collectSourceFiles(rootPath: string, ops: SymbolGraphOperations): Promise<string[]> {
	const info = await ops.stat(rootPath);
	if (!info.isDirectory()) {
		const ext = extname(rootPath).toLowerCase();
		return TS_JS_EXTS.has(ext) ? [rootPath] : [];
	}

	const files: string[] = [];
	const queue: string[] = [rootPath];
	while (queue.length > 0) {
		const current = queue.shift()!;
		const children = await ops.readdir(current);
		for (const child of children) {
			const fullPath = join(current, child);
			const stat = await ops.stat(fullPath);
			if (stat.isDirectory()) {
				if (SKIP_DIRS.has(child)) {
					continue;
				}
				queue.push(fullPath);
				continue;
			}
			const ext = extname(child).toLowerCase();
			if (TS_JS_EXTS.has(ext)) {
				files.push(fullPath);
			}
		}
	}
	return files.sort();
}

function indexGraph(snapshot: SymbolGraphSnapshot): SymbolGraphIndex {
	const nodeById = new Map<string, SymbolNode>();
	const nodeIdsByName = new Map<string, string[]>();
	const edgesByCaller = new Map<string, SymbolEdge[]>();
	const edgesByCallee = new Map<string, SymbolEdge[]>();

	for (const node of snapshot.nodes) {
		nodeById.set(node.id, node);
		appendNameIndex(nodeIdsByName, node.name, node.id);
		if (node.name.includes(".")) {
			appendNameIndex(nodeIdsByName, node.name.slice(node.name.lastIndexOf(".") + 1), node.id);
		}
	}

	for (const edge of snapshot.edges) {
		const callerEdges = edgesByCaller.get(edge.fromId) ?? [];
		callerEdges.push(edge);
		edgesByCaller.set(edge.fromId, callerEdges);
		if (edge.toId) {
			const calleeEdges = edgesByCallee.get(edge.toId) ?? [];
			calleeEdges.push(edge);
			edgesByCallee.set(edge.toId, calleeEdges);
		}
	}

	return {
		snapshot,
		nodeById,
		nodeIdsByName,
		edgesByCaller,
		edgesByCallee,
	};
}

function chooseCalleeId(
	candidates: string[],
	nodeById: Map<string, SymbolNode>,
	callerFile: string,
): string | undefined {
	if (candidates.length === 0) {
		return undefined;
	}
	const sameFile = candidates.find((id) => nodeById.get(id)?.file === callerFile);
	if (sameFile) {
		return sameFile;
	}
	const exported = candidates.find((id) => nodeById.get(id)?.exported);
	return exported ?? candidates[0];
}

async function buildGraph(rootPath: string, ops: SymbolGraphOperations): Promise<SymbolGraphSnapshot> {
	const files = await collectSourceFiles(rootPath, ops);
	const nodes: SymbolNode[] = [];
	const rawEdges: RawEdge[] = [];
	const symbolIdsByName = new Map<string, string[]>();

	for (const absoluteFilePath of files) {
		await ops.access(absoluteFilePath);
		const sourceText = await ops.readFile(absoluteFilePath);
		const sf = ts.createSourceFile(
			absoluteFilePath,
			sourceText,
			ts.ScriptTarget.Latest,
			true,
			getScriptKind(absoluteFilePath),
		);
		const relativeFilePath = normalizePath(relative(rootPath, absoluteFilePath));

		const recordSymbol = (name: string, node: ts.Node, exported: boolean): string => {
			const line = nodeStartLine(sf, node);
			const id = `${relativeFilePath}:${line}:${name}`;
			const symbolNode: SymbolNode = {
				id,
				name,
				file: relativeFilePath,
				line,
				exported,
			};
			nodes.push(symbolNode);
			appendNameIndex(symbolIdsByName, name, id);
			if (name.includes(".")) {
				appendNameIndex(symbolIdsByName, name.slice(name.lastIndexOf(".") + 1), id);
			}
			return id;
		};

		const visitNode = (node: ts.Node, currentSymbolId?: string, className?: string): void => {
			if (ts.isFunctionDeclaration(node) && node.name) {
				const symbolId = recordSymbol(node.name.text, node, hasExportModifier(node));
				ts.forEachChild(node, (child) => visitNode(child, symbolId, className));
				return;
			}

			if (ts.isMethodDeclaration(node) && node.name) {
				const methodName = node.name.getText(sf);
				const symbolName = className ? `${className}.${methodName}` : methodName;
				const symbolId = recordSymbol(symbolName, node, false);
				ts.forEachChild(node, (child) => visitNode(child, symbolId, className));
				return;
			}

			if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
				if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) {
					const symbolId = recordSymbol(node.name.text, node, false);
					ts.forEachChild(node.initializer, (child) => visitNode(child, symbolId, className));
					return;
				}
			}

			if (ts.isClassDeclaration(node) && node.name) {
				ts.forEachChild(node, (child) => visitNode(child, currentSymbolId, node.name?.text));
				return;
			}

			if (currentSymbolId && ts.isCallExpression(node)) {
				const callee = extractCalleeName(node.expression);
				if (callee) {
					rawEdges.push({
						fromId: currentSymbolId,
						callee,
						file: relativeFilePath,
						line: nodeStartLine(sf, node),
					});
				}
			}

			ts.forEachChild(node, (child) => visitNode(child, currentSymbolId, className));
		};

		visitNode(sf);
	}

	const nodeById = new Map(nodes.map((node) => [node.id, node] as const));
	const edges: SymbolEdge[] = rawEdges.map((raw) => {
		const candidates = symbolIdsByName.get(raw.callee) ?? [];
		const toId = chooseCalleeId(candidates, nodeById, raw.file);
		return {
			fromId: raw.fromId,
			toId,
			callee: raw.callee,
			file: raw.file,
			line: raw.line,
		};
	});

	return {
		rootPath: normalizePath(rootPath),
		nodes,
		edges,
	};
}

async function getGraphIndex(
	cwd: string,
	inputPath: string | undefined,
	ops: SymbolGraphOperations,
	cache: ToolResultCache | undefined,
	runtime: LectorRuntime | undefined,
): Promise<{ index: SymbolGraphIndex; cacheInfo?: CacheInfo }> {
	const rootPath = resolveToCwd(inputPath || ".", cwd);
	const cacheKey = makeGraphCacheKey(rootPath);
	const cached = cache?.get(cacheKey);
	if (cached) {
		const snapshot = cached.value as SymbolGraphSnapshot | undefined;
		if (snapshot && Array.isArray(snapshot.nodes) && Array.isArray(snapshot.edges)) {
			runtime?.recordCacheHit("graph", cacheKey, cached.ageMs, cached.ttlMs);
			return {
				index: indexGraph(snapshot),
				cacheInfo: {
					hit: true,
					ageMs: cached.ageMs,
					ttlMs: cached.ttlMs,
				},
			};
		}
	}
	runtime?.recordCacheMiss("graph", cacheKey);

	try {
		const snapshot = await buildGraph(rootPath, ops);
		cache?.set(cacheKey, snapshot);
		runtime?.recordIndexUpdated("graph", {
			rootPath: snapshot.rootPath,
			nodes: snapshot.nodes.length,
			edges: snapshot.edges.length,
		});
		return {
			index: indexGraph(snapshot),
			cacheInfo: {
				hit: false,
			},
		};
	} catch (error) {
		runtime?.recordError("graph.build", error, { rootPath });
		throw error;
	}
}

function resolveSymbolIds(index: SymbolGraphIndex, query: string): string[] {
	const direct = index.nodeIdsByName.get(query);
	if (direct && direct.length > 0) {
		return [...direct];
	}
	const lowered = query.toLowerCase();
	const result = new Set<string>();
	for (const [name, ids] of index.nodeIdsByName.entries()) {
		if (name.toLowerCase().includes(lowered)) {
			for (const id of ids) {
				result.add(id);
			}
		}
	}
	return [...result];
}

function formatCacheLine(cacheInfo: CacheInfo | undefined): string | undefined {
	if (!cacheInfo) {
		return undefined;
	}
	if (!cacheInfo.hit) {
		return "Cache: miss";
	}
	const age = cacheInfo.ageMs ?? 0;
	const ttl = cacheInfo.ttlMs ?? 0;
	return `Cache: hit (age=${age}ms ttl=${ttl}ms)`;
}

const symbolGraphSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Directory or file path to analyze (default: current directory)" })),
	limit: Type.Optional(Type.Number({ description: "Max rows per section (default: 200)" })),
	includeUnresolved: Type.Optional(Type.Boolean({ description: "Include unresolved callees (default: false)" })),
});

const symbolCallersSchema = Type.Object({
	symbol: Type.String({ description: "Symbol name or partial symbol (for example: foo or Service.run)" }),
	path: Type.Optional(Type.String({ description: "Directory or file path to analyze (default: current directory)" })),
	limit: Type.Optional(Type.Number({ description: "Max caller rows to return (default: 200)" })),
});

const symbolCalleesSchema = Type.Object({
	symbol: Type.String({ description: "Symbol name or partial symbol (for example: foo or Service.run)" }),
	path: Type.Optional(Type.String({ description: "Directory or file path to analyze (default: current directory)" })),
	limit: Type.Optional(Type.Number({ description: "Max callee rows to return (default: 200)" })),
});

const symbolDataflowSchema = Type.Object({
	entry: Type.String({ description: "Entry symbol for the dataflow traversal" }),
	path: Type.Optional(Type.String({ description: "Directory or file path to analyze (default: current directory)" })),
	depth: Type.Optional(Type.Number({ description: "Traversal depth in call edges (default: 4)" })),
	limit: Type.Optional(Type.Number({ description: "Max dataflow edges to return (default: 200)" })),
});

export type SymbolGraphToolInput = Static<typeof symbolGraphSchema>;
export type SymbolCallersToolInput = Static<typeof symbolCallersSchema>;
export type SymbolCalleesToolInput = Static<typeof symbolCalleesSchema>;
export type SymbolDataflowToolInput = Static<typeof symbolDataflowSchema>;

export interface SymbolGraphToolDetails {
	truncated?: boolean;
	maxLines?: number;
	cache?: CacheInfo;
}

function formatCall(
	toolName: string,
	args: { path?: string; symbol?: string; entry?: string; depth?: number } | undefined,
	theme: typeof import("../../modes/interactive/theme/theme.js").theme,
): string {
	const invalidArg = invalidArgText(theme);
	const rawPath = str(args?.path);
	const pathDisplay =
		rawPath === null ? invalidArg : rawPath ? theme.fg("accent", shortenPath(rawPath)) : theme.fg("toolOutput", ".");
	const subject = args?.symbol ?? args?.entry;
	const subjectSuffix = subject ? theme.fg("toolOutput", ` ${subject}`) : "";
	const depthSuffix = args?.depth !== undefined ? theme.fg("toolOutput", ` depth=${args.depth}`) : "";
	return `${theme.fg("toolTitle", theme.bold(toolName))} ${pathDisplay}${subjectSuffix}${depthSuffix}`;
}

function formatResult(
	result: { content: Array<{ type: string; text?: string }>; details?: SymbolGraphToolDetails },
	options: ToolRenderResultOptions,
	theme: typeof import("../../modes/interactive/theme/theme.js").theme,
): string {
	let text = "";
	for (const item of result.content) {
		if (item.type === "text" && item.text) {
			text += item.text;
		}
	}
	const lines = text.split("\n");
	const maxLines = options.expanded ? lines.length : 30;
	const rendered = lines.slice(0, maxLines).join("\n");
	const remaining = lines.length - maxLines;
	let output = rendered;
	if (remaining > 0) {
		output += `\n${theme.fg("muted", `... (${remaining} more lines)`)}`;
	}
	return output.trim();
}

interface CachedToolResponse {
	content: Array<{ type: "text"; text: string }>;
	details: SymbolGraphToolDetails | undefined;
}

function isCachedToolResponse(value: unknown): value is CachedToolResponse {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const candidate = value as Partial<CachedToolResponse>;
	return (
		Array.isArray(candidate.content) &&
		candidate.content.every((item) => item.type === "text") &&
		Object.hasOwn(candidate, "details")
	);
}

function readCachedQuery(
	cache: ToolResultCache | undefined,
	runtime: LectorRuntime | undefined,
	key: string,
): CachedToolResponse | undefined {
	const cached = cache?.get(key);
	if (!cached) {
		runtime?.recordCacheMiss("query", key);
		return undefined;
	}
	if (!isCachedToolResponse(cached.value)) {
		runtime?.recordCacheMiss("query", key);
		return undefined;
	}
	runtime?.recordCacheHit("query", key, cached.ageMs, cached.ttlMs);
	return {
		content: cached.value.content,
		details: cached.value.details,
	};
}

function writeCachedQuery(cache: ToolResultCache | undefined, key: string, response: CachedToolResponse): void {
	cache?.set(key, response);
}

export function createSymbolGraphToolDefinition(
	cwd: string,
	options?: SymbolGraphToolOptions,
): ToolDefinition<typeof symbolGraphSchema, SymbolGraphToolDetails | undefined> {
	const ops = options?.operations ?? defaultSymbolGraphOperations;
	const runtime = options?.runtime;
	const graphCache = options?.cache ?? runtime?.getCache("graph");
	const queryCache = options?.queryCache ?? runtime?.getCache("query");
	return {
		name: "symbol_graph",
		label: "symbol_graph",
		description:
			"Lector TS graph: build workspace symbol nodes and call edges using the TypeScript compiler API. Suitable for fast structure maps before deeper analysis.",
		promptSnippet: "Build a TypeScript symbol graph (nodes + call edges) for this workspace",
		promptGuidelines: [
			"Use symbol_graph before broad file reads when mapping TypeScript module and call structure",
			"For precise edits, follow graph exploration with targeted file_read/file_edit",
		],
		parameters: symbolGraphSchema,
		async execute(_toolCallId, params: SymbolGraphToolInput) {
			await runtime?.ensureBootstrapped();
			const limit = Math.max(1, Math.floor(params.limit ?? DEFAULT_LIST_LIMIT));
			const queryKey = makeQueryCacheKey("symbol_graph", {
				path: params.path ?? ".",
				limit,
				includeUnresolved: params.includeUnresolved ?? false,
			});
			const cachedResponse = readCachedQuery(queryCache, runtime, queryKey);
			if (cachedResponse) {
				return cachedResponse;
			}
			const graph = await getGraphIndex(cwd, params.path, ops, graphCache, runtime);
			const unresolved = params.includeUnresolved
				? graph.index.snapshot.edges
				: graph.index.snapshot.edges.filter((edge) => !!edge.toId);
			const nodeLines = graph.index.snapshot.nodes
				.slice(0, limit)
				.map((node) => `- ${node.name} (${node.file}:${node.line})`);
			const edgeLines = unresolved.slice(0, limit).map((edge) => {
				const caller = graph.index.nodeById.get(edge.fromId)?.name ?? edge.fromId;
				const callee = edge.toId
					? (graph.index.nodeById.get(edge.toId)?.name ?? edge.callee)
					: `${edge.callee} (unresolved)`;
				return `- ${caller} -> ${callee} (${edge.file}:${edge.line})`;
			});

			const lines = [
				"# Lector symbol graph (TypeScript)",
				`Root: ${graph.index.snapshot.rootPath}`,
				`Nodes: ${graph.index.snapshot.nodes.length}`,
				`Edges: ${graph.index.snapshot.edges.length}`,
				formatCacheLine(graph.cacheInfo),
				"",
				"## Nodes",
				...(nodeLines.length > 0 ? nodeLines : ["(none)"]),
				"",
				"## Edges",
				...(edgeLines.length > 0 ? edgeLines : ["(none)"]),
			].filter((line): line is string => line !== undefined);

			const output = lines.join("\n");
			const { text, truncated } = truncateLines(output, MAX_OUTPUT_LINES);
			const response: CachedToolResponse = {
				content: [{ type: "text", text }],
				details: {
					truncated,
					maxLines: MAX_OUTPUT_LINES,
					cache: graph.cacheInfo,
				},
			};
			writeCachedQuery(queryCache, queryKey, response);
			return response;
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatCall("symbol_graph", args, theme));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatResult(result as any, options, theme));
			return text;
		},
	};
}

export function createSymbolCallersToolDefinition(
	cwd: string,
	options?: SymbolGraphToolOptions,
): ToolDefinition<typeof symbolCallersSchema, SymbolGraphToolDetails | undefined> {
	const ops = options?.operations ?? defaultSymbolGraphOperations;
	const runtime = options?.runtime;
	const graphCache = options?.cache ?? runtime?.getCache("graph");
	const queryCache = options?.queryCache ?? runtime?.getCache("query");
	return {
		name: "symbol_callers",
		label: "symbol_callers",
		description: "Lector TS graph: list callers for a symbol using workspace call edges.",
		promptSnippet: "Find callers of a TypeScript symbol",
		parameters: symbolCallersSchema,
		async execute(_toolCallId, params: SymbolCallersToolInput) {
			const limit = Math.max(1, Math.floor(params.limit ?? DEFAULT_LIST_LIMIT));
			await runtime?.ensureBootstrapped();
			const queryKey = makeQueryCacheKey("symbol_callers", {
				path: params.path ?? ".",
				symbol: params.symbol,
				limit,
			});
			const cachedResponse = readCachedQuery(queryCache, runtime, queryKey);
			if (cachedResponse) {
				return cachedResponse;
			}
			const graph = await getGraphIndex(cwd, params.path, ops, graphCache, runtime);
			const targetIds = resolveSymbolIds(graph.index, params.symbol);
			if (targetIds.length === 0) {
				const response: CachedToolResponse = {
					content: [{ type: "text", text: `No symbol matched "${params.symbol}".` }],
					details: {
						truncated: false,
						maxLines: MAX_OUTPUT_LINES,
						cache: graph.cacheInfo,
					},
				};
				writeCachedQuery(queryCache, queryKey, response);
				return response;
			}

			const rows: string[] = [];
			for (const targetId of targetIds) {
				const target = graph.index.nodeById.get(targetId);
				if (!target) {
					continue;
				}
				const incoming = graph.index.edgesByCallee.get(targetId) ?? [];
				if (incoming.length === 0) {
					rows.push(`- ${target.name}: (no callers)`);
					continue;
				}
				for (const edge of incoming) {
					const caller = graph.index.nodeById.get(edge.fromId);
					if (!caller) {
						continue;
					}
					rows.push(`- ${target.name} <- ${caller.name} (${edge.file}:${edge.line})`);
					if (rows.length >= limit) {
						break;
					}
				}
				if (rows.length >= limit) {
					break;
				}
			}

			const lines = [
				`# Callers for ${params.symbol}`,
				`Root: ${graph.index.snapshot.rootPath}`,
				formatCacheLine(graph.cacheInfo),
				"",
				...(rows.length > 0 ? rows : ["(none)"]),
			].filter((line): line is string => line !== undefined);
			const { text, truncated } = truncateLines(lines.join("\n"), MAX_OUTPUT_LINES);
			const response: CachedToolResponse = {
				content: [{ type: "text", text }],
				details: {
					truncated,
					maxLines: MAX_OUTPUT_LINES,
					cache: graph.cacheInfo,
				},
			};
			writeCachedQuery(queryCache, queryKey, response);
			return response;
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatCall("symbol_callers", args, theme));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatResult(result as any, options, theme));
			return text;
		},
	};
}

export function createSymbolCalleesToolDefinition(
	cwd: string,
	options?: SymbolGraphToolOptions,
): ToolDefinition<typeof symbolCalleesSchema, SymbolGraphToolDetails | undefined> {
	const ops = options?.operations ?? defaultSymbolGraphOperations;
	const runtime = options?.runtime;
	const graphCache = options?.cache ?? runtime?.getCache("graph");
	const queryCache = options?.queryCache ?? runtime?.getCache("query");
	return {
		name: "symbol_callees",
		label: "symbol_callees",
		description: "Lector TS graph: list callees for a symbol using workspace call edges.",
		promptSnippet: "Find callees of a TypeScript symbol",
		parameters: symbolCalleesSchema,
		async execute(_toolCallId, params: SymbolCalleesToolInput) {
			const limit = Math.max(1, Math.floor(params.limit ?? DEFAULT_LIST_LIMIT));
			await runtime?.ensureBootstrapped();
			const queryKey = makeQueryCacheKey("symbol_callees", {
				path: params.path ?? ".",
				symbol: params.symbol,
				limit,
			});
			const cachedResponse = readCachedQuery(queryCache, runtime, queryKey);
			if (cachedResponse) {
				return cachedResponse;
			}
			const graph = await getGraphIndex(cwd, params.path, ops, graphCache, runtime);
			const targetIds = resolveSymbolIds(graph.index, params.symbol);
			if (targetIds.length === 0) {
				const response: CachedToolResponse = {
					content: [{ type: "text", text: `No symbol matched "${params.symbol}".` }],
					details: {
						truncated: false,
						maxLines: MAX_OUTPUT_LINES,
						cache: graph.cacheInfo,
					},
				};
				writeCachedQuery(queryCache, queryKey, response);
				return response;
			}

			const rows: string[] = [];
			for (const targetId of targetIds) {
				const target = graph.index.nodeById.get(targetId);
				if (!target) {
					continue;
				}
				const outgoing = graph.index.edgesByCaller.get(targetId) ?? [];
				if (outgoing.length === 0) {
					rows.push(`- ${target.name}: (no callees)`);
					continue;
				}
				for (const edge of outgoing) {
					const callee = edge.toId
						? (graph.index.nodeById.get(edge.toId)?.name ?? edge.callee)
						: `${edge.callee} (unresolved)`;
					rows.push(`- ${target.name} -> ${callee} (${edge.file}:${edge.line})`);
					if (rows.length >= limit) {
						break;
					}
				}
				if (rows.length >= limit) {
					break;
				}
			}

			const lines = [
				`# Callees for ${params.symbol}`,
				`Root: ${graph.index.snapshot.rootPath}`,
				formatCacheLine(graph.cacheInfo),
				"",
				...(rows.length > 0 ? rows : ["(none)"]),
			].filter((line): line is string => line !== undefined);
			const { text, truncated } = truncateLines(lines.join("\n"), MAX_OUTPUT_LINES);
			const response: CachedToolResponse = {
				content: [{ type: "text", text }],
				details: {
					truncated,
					maxLines: MAX_OUTPUT_LINES,
					cache: graph.cacheInfo,
				},
			};
			writeCachedQuery(queryCache, queryKey, response);
			return response;
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatCall("symbol_callees", args, theme));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatResult(result as any, options, theme));
			return text;
		},
	};
}

export function createSymbolDataflowToolDefinition(
	cwd: string,
	options?: SymbolGraphToolOptions,
): ToolDefinition<typeof symbolDataflowSchema, SymbolGraphToolDetails | undefined> {
	const ops = options?.operations ?? defaultSymbolGraphOperations;
	const runtime = options?.runtime;
	const graphCache = options?.cache ?? runtime?.getCache("graph");
	const queryCache = options?.queryCache ?? runtime?.getCache("query");
	return {
		name: "symbol_dataflow",
		label: "symbol_dataflow",
		description:
			"Lector TS graph: trace a bounded dataflow/callflow from an entry symbol through workspace call edges.",
		promptSnippet: "Trace bounded TypeScript dataflow from an entry symbol",
		parameters: symbolDataflowSchema,
		async execute(_toolCallId, params: SymbolDataflowToolInput) {
			const depth = Math.max(1, Math.floor(params.depth ?? DEFAULT_DATAFLOW_DEPTH));
			const limit = Math.max(1, Math.floor(params.limit ?? DEFAULT_LIST_LIMIT));
			await runtime?.ensureBootstrapped();
			const queryKey = makeQueryCacheKey("symbol_dataflow", {
				path: params.path ?? ".",
				entry: params.entry,
				depth,
				limit,
			});
			const cachedResponse = readCachedQuery(queryCache, runtime, queryKey);
			if (cachedResponse) {
				return cachedResponse;
			}
			const graph = await getGraphIndex(cwd, params.path, ops, graphCache, runtime);
			const entryIds = resolveSymbolIds(graph.index, params.entry);
			if (entryIds.length === 0) {
				const response: CachedToolResponse = {
					content: [{ type: "text", text: `No entry symbol matched "${params.entry}".` }],
					details: {
						truncated: false,
						maxLines: MAX_OUTPUT_LINES,
						cache: graph.cacheInfo,
					},
				};
				writeCachedQuery(queryCache, queryKey, response);
				return response;
			}

			const rows: string[] = [];
			const queue: Array<{ id: string; depth: number }> = entryIds.map((id) => ({ id, depth: 0 }));
			const visited = new Set<string>();
			while (queue.length > 0 && rows.length < limit) {
				const next = queue.shift()!;
				const marker = `${next.id}@${next.depth}`;
				if (visited.has(marker)) {
					continue;
				}
				visited.add(marker);
				if (next.depth >= depth) {
					continue;
				}

				const outgoing = graph.index.edgesByCaller.get(next.id) ?? [];
				for (const edge of outgoing) {
					const caller = graph.index.nodeById.get(edge.fromId)?.name ?? edge.fromId;
					const callee = edge.toId
						? (graph.index.nodeById.get(edge.toId)?.name ?? edge.callee)
						: `${edge.callee} (unresolved)`;
					rows.push(`- d${next.depth + 1}: ${caller} -> ${callee} (${edge.file}:${edge.line})`);
					if (edge.toId) {
						queue.push({ id: edge.toId, depth: next.depth + 1 });
					}
					if (rows.length >= limit) {
						break;
					}
				}
			}

			const lines = [
				`# Dataflow from ${params.entry}`,
				`Root: ${graph.index.snapshot.rootPath}`,
				`Depth: ${depth}`,
				formatCacheLine(graph.cacheInfo),
				"",
				...(rows.length > 0 ? rows : ["(none)"]),
			].filter((line): line is string => line !== undefined);
			const { text, truncated } = truncateLines(lines.join("\n"), MAX_OUTPUT_LINES);
			const response: CachedToolResponse = {
				content: [{ type: "text", text }],
				details: {
					truncated,
					maxLines: MAX_OUTPUT_LINES,
					cache: graph.cacheInfo,
				},
			};
			writeCachedQuery(queryCache, queryKey, response);
			return response;
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatCall("symbol_dataflow", args, theme));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatResult(result as any, options, theme));
			return text;
		},
	};
}

export function createSymbolGraphTool(
	cwd: string,
	options?: SymbolGraphToolOptions,
): AgentTool<typeof symbolGraphSchema> {
	return wrapToolDefinition(createSymbolGraphToolDefinition(cwd, options));
}

export function createSymbolCallersTool(
	cwd: string,
	options?: SymbolGraphToolOptions,
): AgentTool<typeof symbolCallersSchema> {
	return wrapToolDefinition(createSymbolCallersToolDefinition(cwd, options));
}

export function createSymbolCalleesTool(
	cwd: string,
	options?: SymbolGraphToolOptions,
): AgentTool<typeof symbolCalleesSchema> {
	return wrapToolDefinition(createSymbolCalleesToolDefinition(cwd, options));
}

export function createSymbolDataflowTool(
	cwd: string,
	options?: SymbolGraphToolOptions,
): AgentTool<typeof symbolDataflowSchema> {
	return wrapToolDefinition(createSymbolDataflowToolDefinition(cwd, options));
}
