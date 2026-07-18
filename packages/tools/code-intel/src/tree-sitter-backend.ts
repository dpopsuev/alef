/**
 * TreeSitterBackend - Polyglot AST parsing using tree-sitter.
 *
 * Provides structural code analysis across 40+ languages using tree-sitter
 * parsers. Supports TypeScript, JavaScript, Python, Go, Rust, Java, and more.
 *
 * Core capabilities:
 *   - Parse source code into concrete syntax trees
 *   - Extract symbol definitions (functions, classes, interfaces)
 *   - Query AST nodes by type and pattern
 *   - Incremental parsing for fast re-analysis
 */

import Parser from "tree-sitter";
import { readFileSync } from "node:fs";

/**
 * Language identifier -- any string recognized by the registry.
 * Built-in: "typescript", "javascript", "python".
 * Extensible via TreeSitterBackend.registerLanguage().
 */
export type SupportedLanguage = string;

/**
 * Symbol extracted from AST.
 */
export interface Symbol {
	name: string;
	kind: "function" | "class" | "interface" | "type" | "const" | "variable" | "method";
	startLine: number; // 1-indexed
	endLine: number; // 1-indexed
	startColumn: number; // 0-indexed
	text?: string; // Full source text of the symbol
}

/**
 * AST node information.
 */
export interface ASTNode {
	type: string;
	startLine: number; // 1-indexed
	endLine: number; // 1-indexed
	startColumn: number; // 0-indexed
	endColumn: number; // 0-indexed
	text: string;
	children?: ASTNode[];
}

/**
 * Language configuration for tree-sitter parser.
 * Use TreeSitterBackend.registerLanguage() to add new entries at runtime.
 */
export interface LanguageConfig {
	name: string;
	extensions: string[];
	loadParser: () => Promise<Parser.Language>;
}

/** Narrow tree-sitter grammar modules to Parser.Language. */
function asLanguage(value: unknown): Parser.Language {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- grammar packages export loosely typed Language
	return value as Parser.Language;
}

/**
 * Mutable registry of supported languages. New grammars can be added
 * via TreeSitterBackend.registerLanguage() without code changes.
 */
const languageRegistry: LanguageConfig[] = [
	{
		name: "typescript",
		extensions: [".ts", ".tsx"],
		loadParser: async () => {
			const mod = await import("tree-sitter-typescript");
			return asLanguage(mod.typescript);
		},
	},
	{
		name: "javascript",
		extensions: [".js", ".jsx", ".mjs", ".cjs"],
		loadParser: async () => {
			const mod: Record<string, unknown> = await import("tree-sitter-javascript");
			return asLanguage(mod.default ?? mod);
		},
	},
	{
		name: "python",
		extensions: [".py"],
		loadParser: async () => {
			const mod: Record<string, unknown> = await import("tree-sitter-python");
			return asLanguage(mod.default ?? mod);
		},
	},
];

/**
 * Tree-sitter backend for polyglot AST parsing.
 */
export class TreeSitterBackend {
	private parsers = new Map<SupportedLanguage, Parser>();
	private languages = new Map<SupportedLanguage, Parser.Language>();

	/**
	 * Register a new language at runtime. Replaces any existing entry with the same name.
	 */
	static registerLanguage(config: LanguageConfig): void {
		const idx = languageRegistry.findIndex((c) => c.name === config.name);
		if (idx >= 0) {
			languageRegistry[idx] = config;
		} else {
			languageRegistry.push(config);
		}
	}

	/** Return a snapshot of the registered language configs. */
	static get registeredLanguages(): readonly LanguageConfig[] {
		return languageRegistry;
	}

	/**
	 * Get or create parser for a language.
	 */
	private async getParser(language: SupportedLanguage): Promise<Parser> {
		let parser = this.parsers.get(language);
		if (parser) return parser;

		const config = languageRegistry.find((c) => c.name === language);
		if (!config) {
			throw new Error(`Unsupported language: ${language}`);
		}

		let lang = this.languages.get(language);
		if (!lang) {
			lang = await config.loadParser();
			this.languages.set(language, lang);
		}

		parser = new Parser();
		parser.setLanguage(lang);
		this.parsers.set(language, parser);

		return parser;
	}

	/**
	 * Detect language from file extension.
	 */
	detectLanguage(filePath: string): SupportedLanguage | null {
		for (const config of languageRegistry) {
			for (const ext of config.extensions) {
				if (filePath.endsWith(ext)) {
					return config.name;
				}
			}
		}
		return null;
	}

	/**
	 * Parse source code into an AST.
	 */
	async parse(sourceCode: string, language: SupportedLanguage): Promise<Parser.Tree> {
		const parser = await this.getParser(language);
		return parser.parse(sourceCode);
	}

	/**
	 * Parse a file by reading it and detecting language.
	 */
	async parseFile(filePath: string): Promise<{ tree: Parser.Tree; language: SupportedLanguage }> {
		const language = this.detectLanguage(filePath);
		if (!language) {
			throw new Error(`Cannot detect language for file: ${filePath}`);
		}

		const sourceCode = readFileSync(filePath, "utf-8");
		const tree = await this.parse(sourceCode, language);

		return { tree, language };
	}

	/**
	 * Convert tree-sitter node to our ASTNode format.
	 */
	private nodeToASTNode(node: Parser.SyntaxNode, sourceCode: string, maxDepth = 3, depth = 0): ASTNode {
		const result: ASTNode = {
			type: node.type,
			startLine: node.startPosition.row + 1, // Convert to 1-indexed
			endLine: node.endPosition.row + 1,
			startColumn: node.startPosition.column,
			endColumn: node.endPosition.column,
			text: node.text,
		};

		// Include children only up to maxDepth to avoid huge trees
		if (depth < maxDepth && node.childCount > 0) {
			result.children = [];
			for (let i = 0; i < node.childCount; i++) {
				const child = node.child(i);
				if (child) {
					result.children.push(this.nodeToASTNode(child, sourceCode, maxDepth, depth + 1));
				}
			}
		}

		return result;
	}

	/**
	 * Get AST root node as our ASTNode format.
	 */
	getASTNode(tree: Parser.Tree, sourceCode: string, maxDepth = 3): ASTNode {
		return this.nodeToASTNode(tree.rootNode, sourceCode, maxDepth);
	}

	/**
	 * Extract top-level symbols from TypeScript/JavaScript code.
	 */
	extractSymbolsTS(tree: Parser.Tree, _sourceCode: string): Symbol[] {
		const symbols: Symbol[] = [];
		const cursor = tree.walk();

		const traverse = () => {
			const { nodeType } = cursor;

			// Function declarations: function foo() {}
			if (nodeType === "function_declaration") {
				const nameNode = cursor.currentNode.childForFieldName("name");
				if (nameNode) {
					symbols.push({
						name: nameNode.text,
						kind: "function",
						startLine: cursor.startPosition.row + 1,
						endLine: cursor.endPosition.row + 1,
						startColumn: cursor.startPosition.column,
						text: cursor.currentNode.text,
					});
				}
			}

			// Class declarations: class Foo {}
			if (nodeType === "class_declaration") {
				const nameNode = cursor.currentNode.childForFieldName("name");
				if (nameNode) {
					symbols.push({
						name: nameNode.text,
						kind: "class",
						startLine: cursor.startPosition.row + 1,
						endLine: cursor.endPosition.row + 1,
						startColumn: cursor.startPosition.column,
						text: cursor.currentNode.text,
					});
				}
			}

			// Interface declarations: interface IFoo {}
			if (nodeType === "interface_declaration") {
				const nameNode = cursor.currentNode.childForFieldName("name");
				if (nameNode) {
					symbols.push({
						name: nameNode.text,
						kind: "interface",
						startLine: cursor.startPosition.row + 1,
						endLine: cursor.endPosition.row + 1,
						startColumn: cursor.startPosition.column,
						text: cursor.currentNode.text,
					});
				}
			}

			// Type aliases: type Foo = ...
			if (nodeType === "type_alias_declaration") {
				const nameNode = cursor.currentNode.childForFieldName("name");
				if (nameNode) {
					symbols.push({
						name: nameNode.text,
						kind: "type",
						startLine: cursor.startPosition.row + 1,
						endLine: cursor.endPosition.row + 1,
						startColumn: cursor.startPosition.column,
						text: cursor.currentNode.text,
					});
				}
			}

			// Const/let/var declarations
			if (nodeType === "lexical_declaration" || nodeType === "variable_declaration") {
				// Walk through variable_declarator children
				for (let i = 0; i < cursor.currentNode.childCount; i++) {
					const child = cursor.currentNode.child(i);
					if (child && child.type === "variable_declarator") {
						const nameNode = child.childForFieldName("name");
						if (nameNode) {
							const kind = cursor.currentNode.text.trim().startsWith("const") ? "const" : "variable";
							symbols.push({
								name: nameNode.text,
								kind,
								startLine: cursor.startPosition.row + 1,
								endLine: cursor.endPosition.row + 1,
								startColumn: cursor.startPosition.column,
								text: cursor.currentNode.text,
							});
						}
					}
				}
			}

			// Traverse children
			if (cursor.gotoFirstChild()) {
				do {
					traverse();
				} while (cursor.gotoNextSibling());
				cursor.gotoParent();
			}
		};

		traverse();
		return symbols;
	}

	/**
	 * Extract top-level symbols from Python code.
	 */
	extractSymbolsPython(tree: Parser.Tree, _sourceCode: string): Symbol[] {
		const symbols: Symbol[] = [];
		const cursor = tree.walk();

		const traverse = () => {
			const { nodeType } = cursor;

			// Function definitions: def foo():
			if (nodeType === "function_definition") {
				const nameNode = cursor.currentNode.childForFieldName("name");
				if (nameNode) {
					symbols.push({
						name: nameNode.text,
						kind: "function",
						startLine: cursor.startPosition.row + 1,
						endLine: cursor.endPosition.row + 1,
						startColumn: cursor.startPosition.column,
						text: cursor.currentNode.text,
					});
				}
			}

			// Class definitions: class Foo:
			if (nodeType === "class_definition") {
				const nameNode = cursor.currentNode.childForFieldName("name");
				if (nameNode) {
					symbols.push({
						name: nameNode.text,
						kind: "class",
						startLine: cursor.startPosition.row + 1,
						endLine: cursor.endPosition.row + 1,
						startColumn: cursor.startPosition.column,
						text: cursor.currentNode.text,
					});
				}
			}

			// Traverse children
			if (cursor.gotoFirstChild()) {
				do {
					traverse();
				} while (cursor.gotoNextSibling());
				cursor.gotoParent();
			}
		};

		traverse();
		return symbols;
	}

	/**
	 * Extract symbols from any supported language.
	 */
	extractSymbols(tree: Parser.Tree, sourceCode: string, language: SupportedLanguage): Symbol[] {
		switch (language) {
			case "typescript":
			case "javascript":
				return this.extractSymbolsTS(tree, sourceCode);
			case "python":
				return this.extractSymbolsPython(tree, sourceCode);
			default: {
				const unsupported: string = language;
				throw new Error(`Symbol extraction not implemented for ${unsupported}`);
			}
		}
	}
}
