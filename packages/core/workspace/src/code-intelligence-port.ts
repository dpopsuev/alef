/**
 * CodeIntelligencePort v1 -- semantic, position-based queries only a real language
 * server can honestly answer: where a symbol is actually declared (across files,
 * through re-exports and aliasing), what it resolves to, its type/doc, and what's
 * declared in one file. A tree-sitter-only backend has no type system and cannot
 * honestly answer these, so it must not implement this port at all rather than
 * fake a degraded answer -- callers can rely on every implementation being real.
 */
export const CODE_INTELLIGENCE_PORT_VERSION = 1;

/** A location within a workspace file: 1-indexed line and character. */
export interface WorkspacePosition {
	readonly path: string;
	readonly line: number;
	readonly character: number;
}

/** Same shape as WorkspacePosition -- a location a query resolved to, not one a caller supplied. */
export type WorkspaceLocation = WorkspacePosition;

/** A span within one workspace file: 1-indexed line/character, both ends inclusive of position. */
export interface CodeRange {
	readonly path: string;
	readonly start: { readonly line: number; readonly character: number };
	readonly end: { readonly line: number; readonly character: number };
}

/** One symbol declared in a file, hierarchical -- e.g. a class's methods nest under the class. */
export interface DocumentSymbolEntry {
	readonly name: string;
	readonly kind: string;
	readonly detail?: string;
	/** Encloses the whole declaration, including its body. */
	readonly range: CodeRange;
	/** The narrower span that should be selected/revealed -- typically just the name. */
	readonly selectionRange: CodeRange;
	readonly children?: readonly DocumentSymbolEntry[];
}

/** Standard LSP diagnostic severities. */
export type DiagnosticSeverity = "error" | "warning" | "information" | "hint";

/** One issue a language server reports against a specific range of a file, as of its last analysis. */
export interface Diagnostic {
	readonly range: CodeRange;
	readonly severity: DiagnosticSeverity;
	readonly message: string;
	readonly source?: string;
	readonly code?: string | number;
}

/** Type/doc information for a symbol, flattened to plain text/markdown. */
export interface Hover {
	readonly contents: string;
	readonly range?: CodeRange;
}

/** One node in a call hierarchy: a function/method a query resolved a position to. */
export interface CallHierarchyEntry {
	readonly name: string;
	readonly kind: string;
	readonly detail?: string;
	readonly location: WorkspaceLocation;
	readonly range: CodeRange;
}

/** A caller of the hierarchy root, and the specific ranges within it that make the call. */
export interface IncomingCall {
	readonly from: CallHierarchyEntry;
	readonly fromRanges: readonly CodeRange[];
}

/** A callee of the hierarchy root, and the specific ranges within the root that call it. */
export interface OutgoingCall {
	readonly to: CallHierarchyEntry;
	readonly fromRanges: readonly CodeRange[];
}

/** Semantic, position-based queries for one workspace, backed by a real language server. */
export interface CodeIntelligencePort {
	readonly version: 1;
	/** Where the symbol at `at` is actually declared -- may cross files, may return more than one candidate. */
	goToDefinition(at: WorkspacePosition): Promise<readonly WorkspaceLocation[]>;
	/** Every concrete implementation of the interface/abstract member at `at`. */
	goToImplementation(at: WorkspacePosition): Promise<readonly WorkspaceLocation[]>;
	/** Every project-wide usage of the symbol at `at`. */
	findReferences(at: WorkspacePosition, includeDeclaration: boolean): Promise<readonly WorkspaceLocation[]>;
	/** Type/doc information for the symbol at `at`, or undefined when the server has none. */
	hover(at: WorkspacePosition): Promise<Hover | undefined>;
	/** Every symbol declared in one file, hierarchically. */
	documentSymbols(path: string): Promise<readonly DocumentSymbolEntry[]>;
	/** Every diagnostic currently known for one file, as of the server's last analysis. */
	diagnostics(path: string): Promise<readonly Diagnostic[]>;
	/** The call-hierarchy root(s) the symbol at `at` resolves to -- usually zero or one. */
	prepareCallHierarchy(at: WorkspacePosition): Promise<readonly CallHierarchyEntry[]>;
	/** Every real caller of the symbol at `at`, project-wide. */
	incomingCalls(at: WorkspacePosition): Promise<readonly IncomingCall[]>;
	/** Every function/method the symbol at `at` itself calls. */
	outgoingCalls(at: WorkspacePosition): Promise<readonly OutgoingCall[]>;
}
