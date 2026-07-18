/**
 * Shared graph index payload types (kept free of GraphBackend / Indexer imports).
 */

/**
 *
 */
export interface IndexedImport {
	importPath: string;
	line: number;
	isExternal: boolean;
	resolved: string | null;
	dynamic: boolean;
}

/**
 *
 */
export interface IndexedCall {
	callerName: string;
	calleeName: string;
	line: number;
}

/**
 *
 */
export interface IndexedReference {
	symbolName: string;
	line: number;
	column: number;
	context: string;
	refType: "read" | "write" | "call" | "import" | "type_annotation";
}

/**
 * Dataflow edge between two symbols.
 */
export interface DataflowEdge {
	fromSymbol: string;
	toSymbol: string;
	flowType: "parameter" | "return" | "assignment" | "capture";
	variableName: string | null;
	line: number;
}

/**
 * Complexity metrics for a single function/method.
 */
export interface ComplexityMetrics {
	symbolName: string;
	cyclomatic: number;
	cognitive: number;
	parameters: number;
	linesOfCode: number;
	maxNesting: number;
}
