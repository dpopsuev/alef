/**
 * LectorBackend — the transparent substrate behind LectorOrgan.
 *
 * The LLM sees six clean tool names. The backend decides how each is
 * fulfilled: from the BlockCache, from disk, via TreeSitter, or via LSP.
 * The LLM never knows which path fired — result shape is always the same.
 *
 * Implementations:
 *   LocalLectorBackend  — fs + regex symbols + ripgrep/grep; default
 *   StubLectorBackend   — in-memory; for tests
 *
 * Phase 1: regex symbol extraction, grep-based callers.
 * Phase 2: TreeSitter grammars, LSP call hierarchy.
 */

// ---------------------------------------------------------------------------
// Symbol types
// ---------------------------------------------------------------------------

export type SymbolKind = "function" | "class" | "interface" | "type" | "const" | "variable" | "method" | "property";

export interface SymbolBlock {
	/** Symbol name as declared in source. */
	name: string;
	/** Kind of symbol. */
	kind: SymbolKind;
	/** First line of the declaration (1-indexed). */
	startLine: number;
	/** Last line of the declaration body (1-indexed). */
	endLine: number;
	/** Whether the symbol is exported. */
	exported: boolean;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface ReadResult {
	path: string;
	/** File content — full file or just the requested symbol's block. */
	content: string;
	/** All symbols extracted from the file, regardless of which block was requested. */
	symbols: SymbolBlock[];
	totalLines: number;
	truncated: boolean;
}

export interface SearchMatch {
	path: string;
	/** 1-indexed line number. */
	line: number;
	content: string;
}

export interface CallSite {
	path: string;
	line: number;
	/** Surrounding line content for context. */
	context: string;
}

export interface EditSpec {
	/** Exact text to replace. Must be unique within the file. */
	oldText: string;
	/** Replacement text. */
	newText: string;
}

// ---------------------------------------------------------------------------
// Backend interface
// ---------------------------------------------------------------------------

export interface ReadOptions {
	/**
	 * When set, return only the content of this named symbol's block.
	 * All symbols are still returned in the result regardless.
	 */
	symbol?: string;
	/** Max lines to return. Default varies by mode (full=2000, symbol=300). */
	maxLines?: number;
	/** Line offset for full-file reads. 1-indexed. */
	offset?: number;
}

export interface SearchOptions {
	/** Restrict search to this subdirectory or file. Default: cwd. */
	path?: string;
	caseInsensitive?: boolean;
	/** Max matches to return. Default: 200. */
	maxResults?: number;
	/** Filter files by extension, e.g. "ts" or ".ts". */
	extension?: string;
}

export interface FindOptions {
	/** Root directory to search from. Default: cwd. */
	path?: string;
	/** Max results. Default: 500. */
	maxResults?: number;
	/** Max depth. Default: unlimited. */
	depth?: number;
	/** Include hidden files. Default: false. */
	hidden?: boolean;
}

export interface CallersOptions {
	/** Restrict search to this file or directory. Default: cwd. */
	path?: string;
	/** Max results. Default: 100. */
	maxResults?: number;
}

export interface LectorBackend {
	/** Read a file, optionally zooming into a named symbol's block. */
	read(path: string, opts?: ReadOptions): Promise<ReadResult>;

	/** Write file content, creating parent dirs as needed. */
	write(path: string, content: string): Promise<void>;

	/**
	 * Apply targeted edits. Each edit replaces exactly one occurrence of oldText.
	 * Throws if oldText is not found or is not unique.
	 */
	edit(path: string, edits: EditSpec[]): Promise<void>;

	/** Search file contents for a pattern. */
	search(pattern: string, opts?: SearchOptions): Promise<SearchMatch[]>;

	/** Find files matching a glob pattern. */
	find(glob: string, opts?: FindOptions): Promise<string[]>;

	/**
	 * Find call sites that reference the given symbol name.
	 * Phase 1: grep-based (fast, no LSP required).
	 * Phase 2: LSP callHierarchy (exact, requires server).
	 */
	callers(symbol: string, opts?: CallersOptions): Promise<CallSite[]>;
}
