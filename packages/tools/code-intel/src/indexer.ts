/**
 * Workspace indexer — parse with tree-sitter, persist into GraphBackend.
 */

import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type Parser from "tree-sitter";
import { codeIntelGraphDbPath } from "@dpopsuev/alef-kernel/xdg";
import { computeFileHash } from "./file-hash.js";
import type { GraphBackend } from "./graph-backend.js";
import type { ComplexityMetrics, DataflowEdge, IndexedCall, IndexedImport, IndexedReference } from "./graph-types.js";
import { resolveImportPath, resolveWorkspacePath, toStoredPath } from "./path-resolve.js";
import {
	TreeSitterBackend,
	type SupportedLanguage,
	type Symbol,
} from "./tree-sitter-backend.js";

export type { IndexedCall, IndexedImport, IndexedReference } from "./graph-types.js";

/**
 *
 */
export interface IndexerOptions {
	cwd: string;
	graph: GraphBackend;
	treeSitter?: TreeSitterBackend;
}

/**
 * Indexes source files into the knowledge graph.
 */
export class WorkspaceIndexer {
	private readonly cwd: string;
	private readonly graph: GraphBackend;
	private readonly treeSitter: TreeSitterBackend;
	private ensured = false;

	constructor(opts: IndexerOptions) {
		this.cwd = opts.cwd;
		this.graph = opts.graph;
		this.treeSitter = opts.treeSitter ?? new TreeSitterBackend();
	}

	/** Index changed files under cwd (or a subdirectory). */
	async ensureIndexed(scopePath?: string): Promise<{ changed: number; total: number }> {
		const root = scopePath ? this.resolvePath(scopePath) : this.cwd;
		const scanRoot = existsSync(root) ? root : this.cwd;
		const changed = this.graph.scanWorkspace(scanRoot);
		for (const file of changed) {
			await this.indexFile(file);
		}
		this.graph.relinkDependencies(this.cwd);
		this.ensured = true;
		const total = this.graph.listIndexedFiles().length;
		return { changed: changed.length, total };
	}

	/** Force-index one file (absolute or cwd-relative). */
	async indexFile(filePath: string): Promise<boolean> {
		const absolute = this.resolvePath(filePath);
		const language = this.treeSitter.detectLanguage(absolute);
		if (!language) return false;

		let source: string;
		try {
			source = readFileSync(absolute, "utf-8");
		} catch {
			return false;
		}

		const tree = await this.treeSitter.parse(source, language);
		const symbols = this.treeSitter.extractSymbols(tree, source, language);
		const imports = extractImports(tree, source, language, absolute, this.cwd);
		const calls = extractCalls(tree, source, language, symbols);
		const references = extractReferences(tree, source, language, symbols);
		const complexity = extractComplexity(tree, source, language, symbols);
		const dataflow = extractDataflow(tree, language, symbols);

		const hash = computeFileHash(absolute);
		const storedPath = toStoredPath(absolute, this.cwd);
		this.graph.replaceFileIndex({
			path: storedPath,
			absolutePath: absolute,
			hash,
			language,
			symbols,
			imports,
			calls,
			references,
			complexity,
			dataflow,
			lines: source.split("\n").length,
			sizeBytes: Buffer.byteLength(source, "utf-8"),
		});
		return true;
	}

	/**
	 * Ensure the graph covers `scopePath` (directory/file) or the workspace once.
	 * Scoped calls always refresh that subtree; full workspace indexes at most once
	 * per adapter lifetime (subsequent calls rely on code.index for refresh).
	 */
	async ensureReady(scopePath?: string): Promise<void> {
		if (scopePath) {
			await this.ensureIndexed(scopePath);
			return;
		}
		if (!this.ensured) await this.ensureIndexed();
	}

	private resolvePath(path: string): string {
		return resolveWorkspacePath(path, this.cwd);
	}
}

/** Default on-disk graph: `$XDG_CACHE_HOME/alef/code-intel/<cwd-hash>/graph.db`. */
export function defaultGraphDbPath(cwd: string): string {
	const dbPath = codeIntelGraphDbPath(cwd);
	mkdirSync(dirname(dbPath), { recursive: true });
	return dbPath;
}

/** Extract import edges for the file's language. */
function extractImports(
	tree: Parser.Tree,
	source: string,
	language: SupportedLanguage,
	filePath: string,
	cwd: string,
): IndexedImport[] {
	if (language === "python") return extractPythonImports(tree, source);
	return extractJsImports(tree, source, filePath, cwd);
}

/** Walk JS/TS AST for import/require/export-from statements. */
function extractJsImports(
	tree: Parser.Tree,
	_source: string,
	filePath: string,
	cwd: string,
): IndexedImport[] {
	const imports: IndexedImport[] = [];
	const cursor = tree.walk();

	const visit = (): void => {
		const node = cursor.currentNode;
		const type = cursor.nodeType;

		if (type === "import_statement" || type === "export_statement") {
			const sourceNode =
				node.childForFieldName("source") ??
				node.namedChildren.find((child) => child.type === "string");
			if (sourceNode) {
				const importPath = stripQuotes(sourceNode.text);
				imports.push({
					importPath,
					line: node.startPosition.row + 1,
					isExternal: !importPath.startsWith(".") && !importPath.startsWith("/"),
					resolved: resolveImportPath(importPath, filePath, cwd),
					dynamic: false,
				});
			}
		}

		if (type === "call_expression") {
			const fn = node.childForFieldName("function");
			const args = node.childForFieldName("arguments");
			if (fn && (fn.text === "require" || fn.text === "import") && args && args.namedChildCount > 0) {
				const first = args.namedChild(0);
				if (first?.type === "string") {
					const importPath = stripQuotes(first.text);
					imports.push({
						importPath,
						line: node.startPosition.row + 1,
						isExternal: !importPath.startsWith(".") && !importPath.startsWith("/"),
						resolved: resolveImportPath(importPath, filePath, cwd),
						dynamic: true,
					});
				}
			}
		}

		if (cursor.gotoFirstChild()) {
			do {
				visit();
			} while (cursor.gotoNextSibling());
			cursor.gotoParent();
		}
	};

	visit();
	return imports;
}

/** Walk Python AST for import / from-import statements. */
function extractPythonImports(tree: Parser.Tree, _source: string): IndexedImport[] {
	const imports: IndexedImport[] = [];
	const cursor = tree.walk();

	const visit = (): void => {
		const node = cursor.currentNode;
		const type = cursor.nodeType;
		if (type === "import_statement" || type === "import_from_statement") {
			const moduleNode =
				node.childForFieldName("module_name") ??
				node.namedChildren.find((child) => child.type === "dotted_name" || child.type === "relative_import");
			const importPath = moduleNode?.text ?? node.text;
			imports.push({
				importPath,
				line: node.startPosition.row + 1,
				isExternal: !importPath.startsWith("."),
				resolved: null,
				dynamic: false,
			});
		}
		if (cursor.gotoFirstChild()) {
			do {
				visit();
			} while (cursor.gotoNextSibling());
			cursor.gotoParent();
		}
	};

	visit();
	return imports;
}

/** Collect call edges keyed by enclosing symbol name. */
function extractCalls(
	tree: Parser.Tree,
	_source: string,
	language: SupportedLanguage,
	symbols: Symbol[],
): IndexedCall[] {
	const calls: IndexedCall[] = [];
	const cursor = tree.walk();

	const isPython = language === "python";
	const callType = isPython ? "call" : "call_expression";
	const memberType = isPython ? "attribute" : "member_expression";
	const memberField = isPython ? "attribute" : "property";

	const enclosingSymbol = (line: number): string => {
		let best: Symbol | undefined;
		for (const symbol of symbols) {
			if (line >= symbol.startLine && line <= symbol.endLine) {
				if (!best || symbol.startLine >= best.startLine) best = symbol;
			}
		}
		return best?.name ?? "<module>";
	};

	const visit = (): void => {
		const node = cursor.currentNode;
		if (cursor.nodeType === callType) {
			const fn = node.childForFieldName("function");
			if (fn) {
				const calleeName =
					fn.type === memberType
						? (fn.childForFieldName(memberField)?.text ?? fn.text)
						: fn.text;
				const line = node.startPosition.row + 1;
				calls.push({
					callerName: enclosingSymbol(line),
					calleeName,
					line,
				});
			}
		}
		if (cursor.gotoFirstChild()) {
			do {
				visit();
			} while (cursor.gotoNextSibling());
			cursor.gotoParent();
		}
	};

	visit();
	return calls;
}

/** Collect identifier uses of symbols defined in the same file. */
function extractReferences(
	tree: Parser.Tree,
	source: string,
	language: SupportedLanguage,
	symbols: Symbol[],
): IndexedReference[] {
	const names = new Set(symbols.map((symbol) => symbol.name));
	if (names.size === 0) return [];

	const isPython = language === "python";
	const references: IndexedReference[] = [];
	const cursor = tree.walk();
	const lines = source.split("\n");

	const classifyRef = (node: Parser.SyntaxNode): IndexedReference["refType"] => {
		const parentType = node.parent?.type ?? "";
		if (isPython) {
			if (parentType === "call" || node.parent?.parent?.type === "call") return "call";
			if (parentType === "import_from_statement" || parentType === "import_statement") return "import";
			if (parentType === "type") return "type_annotation";
		} else {
			if (parentType === "call_expression" || node.parent?.parent?.type === "call_expression") return "call";
			if (parentType === "import_specifier" || parentType === "import_clause") return "import";
			if (parentType === "type_annotation" || parentType === "type_identifier") return "type_annotation";
		}
		return "read";
	};

	const visit = (): void => {
		const node = cursor.currentNode;
		if (cursor.nodeType === "identifier" && names.has(node.text)) {
			const line = node.startPosition.row + 1;
			const column = node.startPosition.column;
			const context = (lines[line - 1] ?? "").trim().slice(0, 120);
			references.push({
				symbolName: node.text,
				line,
				column,
				context,
				refType: classifyRef(node),
			});
		}
		if (cursor.gotoFirstChild()) {
			do {
				visit();
			} while (cursor.gotoNextSibling());
			cursor.gotoParent();
		}
	};

	visit();
	return references;
}

/** Compute complexity metrics for function/method symbols. */
function extractComplexity(
	tree: Parser.Tree,
	source: string,
	language: SupportedLanguage,
	symbols: Symbol[],
): ComplexityMetrics[] {
	const isPython = language === "python";
	const funcKinds = new Set(["function", "method"]);
	const funcSymbols = symbols.filter((s) => funcKinds.has(s.kind));
	if (funcSymbols.length === 0) return [];

	const branchTypes = isPython
		? new Set(["if_statement", "elif_clause", "for_statement", "while_statement", "except_clause", "with_statement", "and_operator", "or_operator", "conditional_expression"])
		: new Set(["if_statement", "for_statement", "for_in_statement", "while_statement", "catch_clause", "switch_case", "ternary_expression", "binary_expression"]);
	const logicalOps = new Set(["&&", "||", "??", "and", "or"]);
	const nestingTypes = isPython
		? new Set(["if_statement", "for_statement", "while_statement", "with_statement", "try_statement"])
		: new Set(["if_statement", "for_statement", "for_in_statement", "while_statement", "try_statement", "switch_statement"]);

	const funcNodeType = isPython ? "function_definition" : null;
	const results: ComplexityMetrics[] = [];

	for (const sym of funcSymbols) {
		let cyclomatic = 1;
		let cognitive = 0;
		let maxNesting = 0;
		const bodyLines = sym.endLine - sym.startLine + 1;

		const paramCount = countParameters(tree, sym, isPython, funcNodeType);

		const cursor = tree.walk();
		const countBranches = (depth: number): void => {
			const node = cursor.currentNode;
			const row = node.startPosition.row + 1;
			if (row < sym.startLine || row > sym.endLine) {
				return;
			}

			const type = cursor.nodeType;
			if (branchTypes.has(type)) {
				if (type === "binary_expression") {
					const op = node.childForFieldName("operator")?.text;
					if (op && logicalOps.has(op)) {
						cyclomatic++;
						cognitive += depth;
					}
				} else {
					cyclomatic++;
					cognitive += depth;
				}
			}
			if (nestingTypes.has(type)) {
				if (depth > maxNesting) maxNesting = depth;
			}

			if (cursor.gotoFirstChild()) {
				const nextDepth = nestingTypes.has(type) ? depth + 1 : depth;
				do {
					countBranches(nextDepth);
				} while (cursor.gotoNextSibling());
				cursor.gotoParent();
			}
		};

		countBranches(0);

		results.push({
			symbolName: sym.name,
			cyclomatic,
			cognitive,
			parameters: paramCount,
			linesOfCode: bodyLines,
			maxNesting,
		});
	}

	return results;
}

/** Extract dataflow edges: parameter passing and return value flows for JS/TS. */
function extractDataflow(
	tree: Parser.Tree,
	language: SupportedLanguage,
	symbols: Symbol[],
): DataflowEdge[] {
	if (language === "python") return [];
	const symbolNames = new Set(symbols.map((s) => s.name));
	const funcKinds = new Set(["function", "method"]);
	const funcSymbols = symbols.filter((s) => funcKinds.has(s.kind));
	if (funcSymbols.length === 0) return [];

	const edges: DataflowEdge[] = [];
	const cursor = tree.walk();

	const enclosingFunc = (line: number): Symbol | undefined => {
		let best: Symbol | undefined;
		for (const s of funcSymbols) {
			if (line >= s.startLine && line <= s.endLine) {
				if (!best || s.startLine >= best.startLine) best = s;
			}
		}
		return best;
	};

	const visit = (): void => {
		const node = cursor.currentNode;
		const type = cursor.nodeType;

		if (type === "call_expression") {
			const fn = node.childForFieldName("function");
			const args = node.childForFieldName("arguments");
			const calleeName = fn?.type === "member_expression"
				? fn.childForFieldName("property")?.text
				: fn?.text;
			if (calleeName && args && symbolNames.has(calleeName)) {
				const callLine = node.startPosition.row + 1;
				const caller = enclosingFunc(callLine);
				if (caller && caller.name !== calleeName) {
					for (let i = 0; i < args.namedChildCount; i++) {
						const arg = args.namedChild(i);
						if (!arg || arg.type === "comment") continue;
						const varName = arg.type === "identifier" ? arg.text : null;
						edges.push({
							fromSymbol: caller.name,
							toSymbol: calleeName,
							flowType: "parameter",
							variableName: varName,
							line: callLine,
						});
					}
				}
			}
		}

		if (type === "return_statement") {
			const retValue = node.namedChildren[0];
			if (retValue?.type === "call_expression") {
				const fn = retValue.childForFieldName("function");
				if (fn && symbolNames.has(fn.text)) {
					const line = node.startPosition.row + 1;
					const caller = enclosingFunc(line);
					if (caller) {
						edges.push({
							fromSymbol: fn.text,
							toSymbol: caller.name,
							flowType: "return",
							variableName: null,
							line,
						});
					}
				}
			}
		}

		if (cursor.gotoFirstChild()) {
			do {
				visit();
			} while (cursor.gotoNextSibling());
			cursor.gotoParent();
		}
	};

	visit();
	return edges;
}

/** Count parameters for a function symbol. */
function countParameters(
	tree: Parser.Tree,
	sym: Symbol,
	isPython: boolean,
	funcNodeType: string | null,
): number {
	const cursor = tree.walk();
	const find = (): number => {
		const node = cursor.currentNode;
		const row = node.startPosition.row + 1;
		const isFuncNode = funcNodeType
			? cursor.nodeType === funcNodeType
			: cursor.nodeType === "function_declaration" ||
				cursor.nodeType === "method_definition" ||
				cursor.nodeType === "arrow_function";

		if (isFuncNode && row === sym.startLine) {
			const params = node.childForFieldName("parameters");
			if (params) {
				let count = 0;
				for (let i = 0; i < params.namedChildCount; i++) {
					const child = params.namedChild(i);
					if (!child) continue;
					if (isPython && child.type === "identifier" && child.text === "self") continue;
					count++;
				}
				return count;
			}
			return 0;
		}

		if (cursor.gotoFirstChild()) {
			do {
				const result = find();
				if (result >= 0) return result;
			} while (cursor.gotoNextSibling());
			cursor.gotoParent();
		}
		return -1;
	};

	const result = find();
	return result >= 0 ? result : 0;
}

/** Strip surrounding quotes from a string literal node text. */
function stripQuotes(value: string): string {
	if (
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'")) ||
		(value.startsWith("`") && value.endsWith("`"))
	) {
		return value.slice(1, -1);
	}
	return value;
}
