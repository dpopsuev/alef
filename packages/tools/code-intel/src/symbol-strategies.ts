import type { SymbolBlock } from "./backend.js";
import { extractSymbols } from "./symbol-extractor.js";
import { extractSymbolsTs, isTsFile } from "./ts-symbol-extractor.js";

/**
 *
 */
export interface SymbolExtractorStrategy {
	matches(path: string): boolean;
	extract(content: string, path: string): SymbolBlock[];
}

const SYMBOL_EXTRACTORS: SymbolExtractorStrategy[] = [
	{
		matches: (path) => isTsFile(path),
		extract: (content, path) => extractSymbolsTs(content, path),
	},
	{
		matches: () => true,
		extract: (content) => extractSymbols(content),
	},
];

/**
 *
 */
export function extractSymbolsFor(content: string, path: string): SymbolBlock[] {
	const strategy = SYMBOL_EXTRACTORS.find((s) => s.matches(path));
	return strategy?.extract(content, path) ?? [];
}

/**
 *
 */
export function registerSymbolExtractor(strategy: SymbolExtractorStrategy): void {
	SYMBOL_EXTRACTORS.unshift(strategy);
}
