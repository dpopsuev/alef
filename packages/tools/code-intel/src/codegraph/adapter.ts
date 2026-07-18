/**
 * Adapter: CodeGraph ExtractorOutput -> Alef graph-types.
 *
 * Converts the vendored CodeGraph extractor output into the types
 * consumed by Alef's GraphBackend.replaceFileIndex().
 */

import type { ComplexityMetrics, DataflowEdge, IndexedCall, IndexedImport, IndexedReference } from "../graph-types.js";
import type { Symbol } from "../tree-sitter-backend.js";
import type { ExtractorOutput, SymbolKind as CgSymbolKind } from "./types.js";

type AlefSymbolKind = Symbol["kind"];

/** Map CodeGraph's richer symbol kinds to Alef's 7 kinds. */
function mapKind(kind: CgSymbolKind): AlefSymbolKind {
	switch (kind) {
		case "function":
			return "function";
		case "method":
			return "method";
		case "class":
		case "struct":
		case "record":
			return "class";
		case "interface":
		case "trait":
			return "interface";
		case "type":
		case "enum":
			return "type";
		case "constant":
		case "property":
			return "const";
		case "variable":
		case "parameter":
			return "variable";
		case "module":
		case "namespace":
			return "variable";
		default:
			return "variable";
	}
}

/** Convert CodeGraph definitions to Alef symbols. */
export function adaptSymbols(output: ExtractorOutput): Symbol[] {
	return output.definitions.map((def) => ({
		name: def.name,
		kind: mapKind(def.kind),
		startLine: def.line,
		endLine: def.endLine ?? def.line,
		startColumn: 0,
	}));
}

/** Convert CodeGraph imports to Alef indexed imports. */
export function adaptImports(output: ExtractorOutput): IndexedImport[] {
	return output.imports.map((imp) => ({
		importPath: imp.source,
		line: imp.line,
		isExternal: !imp.source.startsWith(".") && !imp.source.startsWith("/"),
		resolved: null,
		dynamic: imp.dynamicImport ?? false,
	}));
}

/**
 * Convert CodeGraph calls to Alef indexed calls.
 * CodeGraph calls are flat (no callerName). We assign callerName by
 * matching each call's line to the enclosing symbol's line range.
 */
export function adaptCalls(output: ExtractorOutput): IndexedCall[] {
	const symbols = output.definitions;
	const enclosing = (line: number): string => {
		let best: (typeof symbols)[0] | undefined;
		for (const sym of symbols) {
			const endLine = sym.endLine ?? sym.line;
			if (line >= sym.line && line <= endLine) {
				if (!best || sym.line >= best.line) best = sym;
			}
		}
		return best?.name ?? "<module>";
	};

	return output.calls.map((call) => ({
		callerName: enclosing(call.line),
		calleeName: call.receiver ? `${call.receiver}.${call.name}` : call.name,
		line: call.line,
	}));
}

/** Extract complexity metrics from CodeGraph definitions that have them. */
export function adaptComplexity(output: ExtractorOutput): ComplexityMetrics[] {
	const results: ComplexityMetrics[] = [];
	for (const def of output.definitions) {
		if (!def.complexity) continue;
		results.push({
			symbolName: def.name,
			cyclomatic: def.complexity.cyclomatic,
			cognitive: def.complexity.cognitive,
			parameters: def.children?.filter((c) => c.kind === "parameter").length ?? 0,
			linesOfCode: def.complexity.loc?.sloc ?? (def.endLine ? def.endLine - def.line + 1 : 1),
			maxNesting: def.complexity.maxNesting,
		});
	}
	return results;
}

/**
 * Build references from the extractor output.
 * CodeGraph extractors don't produce references directly --
 * Alef's own extractReferences walker handles this for vendored languages too.
 * Returns empty; the indexer will use its own reference extraction.
 */
export function adaptReferences(_output: ExtractorOutput): IndexedReference[] {
	return [];
}

/**
 * Build dataflow edges from the extractor output.
 * CodeGraph's dataflow is a post-extraction analysis phase, not part of
 * the base extractor output. Returns empty; Alef's own dataflow extraction
 * handles this for languages where it's implemented.
 */
export function adaptDataflow(_output: ExtractorOutput): DataflowEdge[] {
	return [];
}
