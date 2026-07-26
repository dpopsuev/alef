import type { WorkspacePosition } from "./code-intelligence-port.js";

/**
 * CallGraphPort v1 -- a persisted, queryable graph of symbol relationships, built by a
 * batch indexing pass rather than answered live per query, so multi-hop questions
 * (transitive callers, reachability) don't require chaining many sequential
 * CodeIntelligencePort calls. maxDepth is required on every traversal: an unbounded
 * walk has no place behind a bounded-resource port.
 */
export const CALL_GRAPH_PORT_VERSION = 1;

/** Which relationship an edge represents between two symbols. */
export type SymbolEdgeKind = "calls" | "references" | "contains";

/** A node's own identity and declaration -- what's shown, not derived relationships. */
export interface SymbolNode {
	readonly id: string;
	readonly name: string;
	readonly kind: string;
	readonly location: WorkspacePosition;
}

/** How much of the workspace a populateSymbolGraph run actually covered. */
export interface PopulateSymbolGraphResult {
	readonly completeness: "complete" | "partial";
	readonly filesProcessed: number;
	readonly filesFailed: number;
	readonly nodesAdded: number;
	readonly edgesAdded: number;
}

/** Persisted symbol-relationship graph for one workspace: populate it, then traverse it. */
export interface CallGraphPort {
	readonly version: 1;
	/** Populate (or refresh) the graph for a workspace, bounded to at most maxFiles/maxSymbolsPerFile. */
	populateSymbolGraph(maxFiles: number, maxSymbolsPerFile: number): Promise<PopulateSymbolGraphResult>;
	/** Direct out-edges from the symbol at `at` -- who/what it points to. */
	edgesFrom(at: WorkspacePosition, kind?: SymbolEdgeKind): Promise<readonly SymbolNode[]>;
	/** Direct in-edges to the symbol at `at` -- who/what points to it. */
	edgesTo(at: WorkspacePosition, kind?: SymbolEdgeKind): Promise<readonly SymbolNode[]>;
	/** Every symbol reachable from `at` by following out-edges, up to maxDepth hops. */
	reachableFrom(at: WorkspacePosition, maxDepth: number, kind?: SymbolEdgeKind): Promise<readonly SymbolNode[]>;
}
