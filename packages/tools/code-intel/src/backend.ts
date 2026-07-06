/**
 * CodeIntelBackend — LSP-based code intelligence backend.
 *
 * Provides TypeScript/JavaScript code intelligence via Language Server Protocol:
 *   - Workspace symbol search
 *   - Hover type information
 *   - Call hierarchy (find callers)
 *   - Diagnostics (compilation errors)
 *
 * Implementations:
 *   LocalCodeIntelBackend  — LSP client + grep fallback; default
 *   StubCodeIntelBackend   — no-op stubs for tests
 */

// ---------------------------------------------------------------------------
// Symbol types (used internally by symbol extractors)
// ---------------------------------------------------------------------------

/**
 *
 */
export type SymbolKind = "function" | "class" | "interface" | "type" | "const" | "variable" | "method" | "property";

/**
 *
 */
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
	/** 0-indexed column of the identifier token — used for precise LSP prepareCallHierarchy. */
	startCharacter?: number;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/**
 *
 */
export interface CallSite {
	path: string;
	line: number;
	/** Surrounding line content for context. */
	context: string;
}

/**
 *
 */
export interface Diagnostic {
	severity: number; // 1=error, 2=warning, 3=info, 4=hint
	message: string;
	line: number; // 1-indexed
	character: number; // 0-indexed
	code?: string | number;
	source?: string;
}

/**
 *
 */
export interface HoverInfo {
	contents: string;
	range?: { start: { line: number; character: number }; end: { line: number; character: number } };
}

/**
 *
 */
export interface WorkspaceSymbol {
	name: string;
	kind: string; // "function", "class", "interface", etc.
	path: string;
	line: number; // 1-indexed
	containerName?: string;
}

// ---------------------------------------------------------------------------
// Options types
// ---------------------------------------------------------------------------

/**
 *
 */
export interface CallersOptions {
	/** Restrict search to this file or directory. Default: cwd. */
	path?: string;
	/** Max results. Default: 100. */
	maxResults?: number;
}

// ---------------------------------------------------------------------------
// Backend interface
// ---------------------------------------------------------------------------

/**
 *
 */
export interface CodeIntelBackend {
	/**
	 * Find call sites that reference the given symbol name.
	 * Uses LSP callHierarchy for TypeScript files, falls back to grep.
	 */
	callers(symbol: string, opts?: CallersOptions): Promise<CallSite[]>;

	/**
	 * Get diagnostics (compilation errors/warnings) for a file.
	 * Requires LSP support for the language (TypeScript).
	 */
	getDiagnostics(path: string): Promise<Diagnostic[]>;

	/**
	 * Get hover information (type info, documentation) at a position.
	 * Requires LSP support for the language (TypeScript).
	 */
	getHover(path: string, line: number, character: number): Promise<HoverInfo | null>;

	/**
	 * Search for symbols across the workspace.
	 * Requires LSP support (TypeScript).
	 */
	workspaceSymbols(query: string): Promise<WorkspaceSymbol[]>;
}
