/**
 * CodeGraph extractor registry -- maps language IDs to extractor functions.
 */

import type { ExtractorOutput, TreeSitterTree } from "./types.js";

/** Signature shared by all CodeGraph language extractors. */
export type ExtractorFn = (tree: TreeSitterTree, filePath: string) => ExtractorOutput;

/**
 * Lazily-loaded extractor registry. Extractors are imported on first use
 * to avoid loading all 33 grammars eagerly.
 */
const extractorCache = new Map<string, ExtractorFn>();

/** Languages handled by Alef's built-in extractors (not routed through CodeGraph). */
const BUILTIN_LANGUAGES = new Set(["typescript", "javascript", "python"]);

/** Map of language ID to dynamic import + function name. */
const EXTRACTOR_MAP: Record<string, { module: string; fn: string }> = {
	go: { module: "./extractors/go.js", fn: "extractGoSymbols" },
	rust: { module: "./extractors/rust.js", fn: "extractRustSymbols" },
	java: { module: "./extractors/java.js", fn: "extractJavaSymbols" },
	csharp: { module: "./extractors/csharp.js", fn: "extractCSharpSymbols" },
	c: { module: "./extractors/c.js", fn: "extractCSymbols" },
	cpp: { module: "./extractors/cpp.js", fn: "extractCppSymbols" },
	kotlin: { module: "./extractors/kotlin.js", fn: "extractKotlinSymbols" },
	swift: { module: "./extractors/swift.js", fn: "extractSwiftSymbols" },
	scala: { module: "./extractors/scala.js", fn: "extractScalaSymbols" },
	ruby: { module: "./extractors/ruby.js", fn: "extractRubySymbols" },
	php: { module: "./extractors/php.js", fn: "extractPHPSymbols" },
	bash: { module: "./extractors/bash.js", fn: "extractBashSymbols" },
	elixir: { module: "./extractors/elixir.js", fn: "extractElixirSymbols" },
	lua: { module: "./extractors/lua.js", fn: "extractLuaSymbols" },
	dart: { module: "./extractors/dart.js", fn: "extractDartSymbols" },
	zig: { module: "./extractors/zig.js", fn: "extractZigSymbols" },
	haskell: { module: "./extractors/haskell.js", fn: "extractHaskellSymbols" },
	ocaml: { module: "./extractors/ocaml.js", fn: "extractOCamlSymbols" },
	fsharp: { module: "./extractors/fsharp.js", fn: "extractFSharpSymbols" },
	gleam: { module: "./extractors/gleam.js", fn: "extractGleamSymbols" },
	clojure: { module: "./extractors/clojure.js", fn: "extractClojureSymbols" },
	julia: { module: "./extractors/julia.js", fn: "extractJuliaSymbols" },
	r: { module: "./extractors/r.js", fn: "extractRSymbols" },
	erlang: { module: "./extractors/erlang.js", fn: "extractErlangSymbols" },
	solidity: { module: "./extractors/solidity.js", fn: "extractSoliditySymbols" },
	objc: { module: "./extractors/objc.js", fn: "extractObjCSymbols" },
	cuda: { module: "./extractors/cuda.js", fn: "extractCudaSymbols" },
	groovy: { module: "./extractors/groovy.js", fn: "extractGroovySymbols" },
	verilog: { module: "./extractors/verilog.js", fn: "extractVerilogSymbols" },
	hcl: { module: "./extractors/hcl.js", fn: "extractHCLSymbols" },
};

/** Check if a language should use the CodeGraph extractor path. */
export function hasCodeGraphExtractor(language: string): boolean {
	return !BUILTIN_LANGUAGES.has(language) && language in EXTRACTOR_MAP;
}

/** Get the extractor for a language, loading it lazily. */
export async function getExtractor(language: string): Promise<ExtractorFn | null> {
	const cached = extractorCache.get(language);
	if (cached) return cached;

	const entry = EXTRACTOR_MAP[language];
	if (!entry) return null;

	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- dynamic import of known extractor modules
	const mod = (await import(entry.module)) as Record<string, ExtractorFn>;
	const fn = mod[entry.fn];
	if (!fn) return null;

	extractorCache.set(language, fn);
	return fn;
}

/** List all available CodeGraph language IDs. */
export function codegraphLanguages(): string[] {
	return Object.keys(EXTRACTOR_MAP);
}
