/**
 * Symbol extractor — Phase 1 implementation using regex line scanning.
 *
 * Handles TypeScript and JavaScript. Extracts: function, class, interface,
 * type alias, const/let/var declarations, arrow functions, and class methods.
 *
 * End-line accuracy: brace counting from the declaration line forward.
 * For type aliases and simple consts: scans to the closing semicolon.
 *
 * Phase 2 will replace this with TreeSitter grammars for all languages.
 */

import type { SymbolBlock, SymbolKind } from "./backend.js";

// ---------------------------------------------------------------------------
// Declaration patterns
// ---------------------------------------------------------------------------

interface RawMatch {
	name: string;
	kind: SymbolKind;
	exported: boolean;
	/** Whether this declaration opens a brace block `{`. */
	hasBlock: boolean;
}

const PATTERNS: Array<{ re: RegExp; map: (m: RegExpMatchArray) => RawMatch }> = [
	// export (async) function name(
	{
		re: /^(export\s+(?:default\s+)?)?async\s+function\s+(\w+)\s*[(<]/,
		map: (m) => ({ name: m[2], kind: "function", exported: !!m[1], hasBlock: true }),
	},
	{
		re: /^(export\s+(?:default\s+)?)?function\s+(\w+)\s*[(<]/,
		map: (m) => ({ name: m[2], kind: "function", exported: !!m[1], hasBlock: true }),
	},
	// export abstract? class Name
	{
		re: /^(export\s+)?(?:abstract\s+)?class\s+(\w+)[\s{<(]/,
		map: (m) => ({ name: m[2], kind: "class", exported: !!m[1], hasBlock: true }),
	},
	// export interface Name
	{
		re: /^(export\s+)?interface\s+(\w+)[\s{<(]/,
		map: (m) => ({ name: m[2], kind: "interface", exported: !!m[1], hasBlock: true }),
	},
	// export type Name = ...
	{
		re: /^(export\s+)?type\s+(\w+)\s*(?:<[^=]+>)?\s*=/,
		map: (m) => ({ name: m[2], kind: "type", exported: !!m[1], hasBlock: false }),
	},
	// export const/let/var name = ... (including arrow functions)
	{
		re: /^(export\s+)?const\s+(\w+)\s*(?::[^=]+)?\s*=/,
		map: (m) => ({ name: m[2], kind: "const", exported: !!m[1], hasBlock: false }),
	},
	{
		re: /^(export\s+)?let\s+(\w+)\s*(?::[^=]+)?\s*=/,
		map: (m) => ({ name: m[2], kind: "variable", exported: !!m[1], hasBlock: false }),
	},
	{
		re: /^(export\s+)?var\s+(\w+)\s*(?::[^=]+)?\s*=/,
		map: (m) => ({ name: m[2], kind: "variable", exported: !!m[1], hasBlock: false }),
	},
];

// Class method pattern — only matches inside indented context
const METHOD_RE = /^\s{2,}(?:(?:public|private|protected|static|async|override|abstract)\s+)*(\w+)\s*[(<]/;
const METHOD_EXCLUDE = /^\s*(?:if|for|while|switch|catch|return|throw|const|let|var|import|export)\b/;

// ---------------------------------------------------------------------------
// End-line resolution
// ---------------------------------------------------------------------------

/**
 * Scan forward from startIdx to find the closing line of a block or statement.
 * Returns 0-indexed line index.
 */
function findEndLine(lines: string[], startIdx: number, hasBlock: boolean): number {
	if (hasBlock) {
		// Count brace depth; end when it returns to 0 after first open.
		let depth = 0;
		let opened = false;
		for (let i = startIdx; i < lines.length; i++) {
			const line = lines[i];
			for (const ch of line) {
				if (ch === "{") {
					depth++;
					opened = true;
				} else if (ch === "}") {
					depth--;
					if (opened && depth === 0) return i;
				}
			}
		}
		return startIdx; // fallback
	}

	// No block — scan for semicolon or until next non-continuation line.
	// Arrow functions with block body: detect `=> {` and switch to brace mode.
	for (let i = startIdx; i < Math.min(startIdx + 50, lines.length); i++) {
		const line = lines[i];

		// Arrow function that opens a block
		if (line.includes("=> {") || line.match(/=>\s*\{/)) {
			return findEndLine(lines, i, true);
		}

		// Semicolon ends the statement (unless inside a template literal)
		if (line.trimEnd().endsWith(";")) return i;

		// Blank or non-continuation line after first
		if (i > startIdx && line.trim() === "") return i - 1;
	}

	return startIdx;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract named symbols from source code.
 * Returns symbols in declaration order.
 */
export function extractSymbols(content: string): SymbolBlock[] {
	const lines = content.split("\n");
	const symbols: SymbolBlock[] = [];
	let insideClass = false;
	let classDepth = 0;

	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i].trimStart();

		// Track class body for method detection
		if (/^(?:export\s+)?(?:abstract\s+)?class\s+\w/.test(raw)) {
			insideClass = true;
			classDepth = 0;
		}
		if (insideClass) {
			for (const ch of lines[i]) {
				if (ch === "{") classDepth++;
				else if (ch === "}") {
					classDepth--;
					if (classDepth <= 0) insideClass = false;
				}
			}
		}

		// Try top-level patterns first
		let matched = false;
		for (const { re, map } of PATTERNS) {
			const m = raw.match(re);
			if (!m) continue;
			const raw_match = map(m);
			const endLine = findEndLine(lines, i, raw_match.hasBlock);
			symbols.push({
				name: raw_match.name,
				kind: raw_match.kind,
				startLine: i + 1,
				endLine: endLine + 1,
				exported: raw_match.exported,
			});
			matched = true;
			break;
		}

		if (matched || !insideClass) continue;

		// Method detection inside classes
		if (METHOD_EXCLUDE.test(lines[i])) continue;
		const mm = lines[i].match(METHOD_RE);
		if (mm && mm[1] !== "constructor") {
			const endLine = findEndLine(lines, i, true);
			symbols.push({
				name: mm[1],
				kind: "method",
				startLine: i + 1,
				endLine: endLine + 1,
				exported: false,
			});
		}
	}

	return symbols;
}

/**
 * Extract the content of a named symbol's block from already-extracted symbols.
 * Returns null if the symbol is not found.
 */
export function extractBlock(
	content: string,
	symbols: SymbolBlock[],
	symbolName: string,
): { content: string; startLine: number; endLine: number } | null {
	const block = symbols.find((s) => s.name === symbolName);
	if (!block) return null;

	const lines = content.split("\n");
	const sliced = lines.slice(block.startLine - 1, block.endLine);
	return {
		content: sliced.join("\n"),
		startLine: block.startLine,
		endLine: block.endLine,
	};
}
