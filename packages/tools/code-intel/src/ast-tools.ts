/**
 * AST-based code intelligence tools.
 * 
 * Provides code.ast.match and code.ast.extract tools using tree-sitter.
 */

import { TreeSitterBackend, type Symbol as TSSymbol, type ASTNode } from "./tree-sitter-backend.js";
import { readFileSync } from "node:fs";
import { glob } from "glob";

/** Options for AST pattern matching across files. */
export interface ASTMatchOptions {
	pattern: string;
	path?: string;
	kind?: string;
	maxResults?: number;
}

/** One symbol match from AST search. */
export interface ASTMatchResult {
	file: string;
	symbol: TSSymbol;
	match: boolean;
	confidence: number;
}

/** Options for extracting a single symbol definition. */
export interface ASTExtractOptions {
	symbol: string;
	path: string;
	kind?: string;
}

/** Full symbol extraction result with source text. */
export interface ASTExtractResult {
	symbol: TSSymbol;
	fullText: string;
	astNode?: ASTNode;
}

/**
 * AST Tools - structural code search and extraction.
 */
export class ASTTools {
	private backend: TreeSitterBackend;

	constructor() {
		this.backend = new TreeSitterBackend();
	}

	/**
	 * Match symbols by pattern across files.
	 * Supports wildcards and fuzzy matching.
	 */
	async match(opts: ASTMatchOptions): Promise<ASTMatchResult[]> {
		const results: ASTMatchResult[] = [];
		const searchPath = opts.path ?? process.cwd();
		const maxResults = opts.maxResults ?? 100;

		// Find TypeScript/JavaScript files
		const pattern = searchPath.endsWith(".ts") || searchPath.endsWith(".js")
			? searchPath
			: `${searchPath}/**/*.{ts,tsx,js,jsx}`;

		const files = await glob(pattern, { ignore: ["**/node_modules/**", "**/dist/**", "**/.git/**"] });

		for (const file of files) {
			if (results.length >= maxResults) break;

			try {
				const language = this.backend.detectLanguage(file);
				if (!language) continue;

				const code = readFileSync(file, "utf-8");
				const tree = await this.backend.parse(code, language);
				const symbols = this.backend.extractSymbols(tree, code, language);

				for (const symbol of symbols) {
					// Filter by kind if specified
					if (opts.kind && symbol.kind !== opts.kind) continue;

					// Match pattern (simple fuzzy match for now)
					const match = this.matchesPattern(symbol.name, opts.pattern);
					if (match) {
						results.push({
							file,
							symbol,
							match: true,
							confidence: this.calculateConfidence(symbol.name, opts.pattern),
						});

						if (results.length >= maxResults) break;
					}
				}
			} catch (_err) {
				continue;
			}
		}

		return results.sort((a, b) => b.confidence - a.confidence);
	}

	/**
	 * Extract full definition of a symbol from a file.
	 */
	async extract(opts: ASTExtractOptions): Promise<ASTExtractResult | null> {
		const language = this.backend.detectLanguage(opts.path);
		if (!language) return null;

		const code = readFileSync(opts.path, "utf-8");
		const tree = await this.backend.parse(code, language);
		const symbols = this.backend.extractSymbols(tree, code, language);

		// Find exact symbol match
		const symbol = symbols.find((s) => {
			if (s.name !== opts.symbol) return false;
			if (opts.kind && s.kind !== opts.kind) return false;
			return true;
		});

		if (!symbol) return null;

		// Get AST node for the symbol
		const astNode = this.backend.getASTNode(tree, code, 5);

		return {
			symbol,
			fullText: symbol.text ?? "",
			astNode,
		};
	}

	/**
	 * Simple pattern matching (supports * wildcard).
	 */
	private matchesPattern(text: string, pattern: string): boolean {
		if (pattern === "*") return true;
		if (!pattern.includes("*")) {
			// Exact match or fuzzy
			return text.toLowerCase().includes(pattern.toLowerCase());
		}

		// Convert wildcard to regex
		const regex = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$", "i");
		return regex.test(text);
	}

	/**
	 * Calculate confidence score (0-1) for a match.
	 */
	private calculateConfidence(text: string, pattern: string): number {
		if (text === pattern) return 1.0;
		if (text.toLowerCase() === pattern.toLowerCase()) return 0.95;

		const textLower = text.toLowerCase();
		const patternLower = pattern.toLowerCase();

		if (textLower.startsWith(patternLower)) return 0.9;
		if (textLower.includes(patternLower)) return 0.8;

		// Fuzzy match score based on character overlap
		const overlap = this.calculateOverlap(textLower, patternLower);
		return Math.max(0.5, overlap);
	}

	private calculateOverlap(a: string, b: string): number {
		let matches = 0;
		const longer = a.length > b.length ? a : b;
		const shorter = a.length > b.length ? b : a;

		for (let i = 0; i < shorter.length; i++) {
			const char = shorter[i];
			if (char && longer.includes(char)) matches++;
		}

		return matches / longer.length;
	}
}
