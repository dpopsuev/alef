/**
 * Unified store — imports JSONL sessions into a graphable, embeddable,
 * queryable, token-cheap data structure.
 *
 * Key rule: every piece of data is:
 *   1. Graphable — linked to other data via typed edges
 *   2. Embeddable — has a vector embedding for semantic search
 *   3. Queryable — addressable by SQL (Dolt) or in-memory index
 *   4. Token-cheap — stored once, referenced by ID, never duplicated in context
 *
 * The store normalizes JSONL entries into three tables:
 *   - nodes: every piece of content (message, tool call, observation, entity)
 *   - edges: typed relationships between nodes
 *   - embeddings: vector column keyed by node ID
 *
 * This replaces the linear JSONL append-only format with a graph
 * that supports O(1) lookup, O(log n) similarity search, and
 * O(k) context assembly (where k = selected nodes, not total history).
 */

import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Node — the universal content unit
// ---------------------------------------------------------------------------

export type NodeKind =
	| "user_message"
	| "assistant_message"
	| "tool_call"
	| "tool_result"
	| "thinking"
	| "observation" // compacted summary
	| "entity" // extracted entity (file, function, concept)
	| "decision" // architectural/design decision
	| "work_item" // goal, task, spec, bug
	| "custom" // extension data
	| "system"; // model change, config change

export interface Node {
	/** Unique ID (UUID) */
	id: string;
	/** What kind of content */
	kind: NodeKind;
	/** Session this belongs to */
	sessionId: string;
	/** Sequential position within the session */
	seq: number;
	/** The actual content (text, JSON, markdown) */
	content: string;
	/** Content hash for dedup (SHA-256 of content) */
	contentHash: string;
	/** Token count estimate (cheap: content.length / 4) */
	tokenEstimate: number;
	/** Agent color (who produced this) */
	source: string;
	/** Timestamp */
	createdAt: number;
	/** Metadata (model info, usage stats, tool name, etc.) */
	meta?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Edge — typed relationship between nodes
// ---------------------------------------------------------------------------

export type EdgeKind =
	| "follows" // sequential: A came after B
	| "responds_to" // assistant responds to user message
	| "calls" // assistant calls a tool
	| "result_of" // tool result of a tool call
	| "summarizes" // observation summarizes a window of nodes
	| "mentions" // entity mentioned in a message
	| "modifies" // tool call modifies an entity (file, function)
	| "depends_on" // work item dependency
	| "implements" // task implements spec/bug
	| "derived_from" // entity derived from another
	| "contradicts" // conflict between facts
	| "references"; // generic cross-reference

export interface Edge {
	id: string;
	fromId: string;
	toId: string;
	kind: EdgeKind;
	/** Optional weight/confidence (0-1) */
	weight?: number;
	createdAt: number;
}

// ---------------------------------------------------------------------------
// Store interface — hexagonal port
// ---------------------------------------------------------------------------

export interface Store {
	// Nodes
	putNode(node: Node): void;
	getNode(id: string): Node | undefined;
	getNodesByKind(kind: NodeKind): Node[];
	getNodesBySession(sessionId: string): Node[];
	getNodesBySource(source: string): Node[];

	// Edges
	putEdge(edge: Edge): void;
	getEdgesFrom(nodeId: string, kind?: EdgeKind): Edge[];
	getEdgesTo(nodeId: string, kind?: EdgeKind): Edge[];

	// Embeddings
	setEmbedding(nodeId: string, vector: Float32Array): void;
	getEmbedding(nodeId: string): Float32Array | undefined;
	/** Find top-K similar nodes by cosine similarity */
	similarTo(vector: Float32Array, k: number, filter?: (node: Node) => boolean): Array<{ node: Node; score: number }>;

	// Query
	search(text: string, limit?: number): Node[];

	// Stats
	nodeCount(): number;
	edgeCount(): number;
}

// ---------------------------------------------------------------------------
// InMemoryStore — development/test implementation
// ---------------------------------------------------------------------------

export class InMemoryStore implements Store {
	private nodes = new Map<string, Node>();
	private edges: Edge[] = [];
	private embeddings = new Map<string, Float32Array>();

	// Index maps for fast lookup
	private byKind = new Map<NodeKind, Set<string>>();
	private bySession = new Map<string, Set<string>>();
	private bySource = new Map<string, Set<string>>();

	// -- Nodes -------------------------------------------------------------

	putNode(node: Node): void {
		this.nodes.set(node.id, node);
		this.addToIndex(this.byKind, node.kind, node.id);
		this.addToIndex(this.bySession, node.sessionId, node.id);
		this.addToIndex(this.bySource, node.source, node.id);
	}

	getNode(id: string): Node | undefined {
		return this.nodes.get(id);
	}

	getNodesByKind(kind: NodeKind): Node[] {
		return this.resolveIndex(this.byKind, kind);
	}

	getNodesBySession(sessionId: string): Node[] {
		return this.resolveIndex(this.bySession, sessionId).sort((a, b) => a.seq - b.seq);
	}

	getNodesBySource(source: string): Node[] {
		return this.resolveIndex(this.bySource, source);
	}

	// -- Edges -------------------------------------------------------------

	putEdge(edge: Edge): void {
		this.edges.push(edge);
	}

	getEdgesFrom(nodeId: string, kind?: EdgeKind): Edge[] {
		return this.edges.filter((e) => e.fromId === nodeId && (!kind || e.kind === kind));
	}

	getEdgesTo(nodeId: string, kind?: EdgeKind): Edge[] {
		return this.edges.filter((e) => e.toId === nodeId && (!kind || e.kind === kind));
	}

	// -- Embeddings --------------------------------------------------------

	setEmbedding(nodeId: string, vector: Float32Array): void {
		this.embeddings.set(nodeId, vector);
	}

	getEmbedding(nodeId: string): Float32Array | undefined {
		return this.embeddings.get(nodeId);
	}

	similarTo(query: Float32Array, k: number, filter?: (node: Node) => boolean): Array<{ node: Node; score: number }> {
		const results: Array<{ node: Node; score: number }> = [];

		for (const [nodeId, vector] of this.embeddings) {
			const node = this.nodes.get(nodeId);
			if (!node) continue;
			if (filter && !filter(node)) continue;

			const score = cosineSimilarity(query, vector);
			results.push({ node, score });
		}

		results.sort((a, b) => b.score - a.score);
		return results.slice(0, k);
	}

	// -- Query -------------------------------------------------------------

	search(text: string, limit = 20): Node[] {
		const lower = text.toLowerCase();
		const results: Node[] = [];
		for (const node of this.nodes.values()) {
			if (node.content.toLowerCase().includes(lower)) {
				results.push(node);
				if (results.length >= limit) break;
			}
		}
		return results;
	}

	// -- Stats -------------------------------------------------------------

	nodeCount(): number {
		return this.nodes.size;
	}

	edgeCount(): number {
		return this.edges.length;
	}

	// -- Internal ----------------------------------------------------------

	private addToIndex<K>(index: Map<K, Set<string>>, key: K, id: string): void {
		let set = index.get(key);
		if (!set) {
			set = new Set();
			index.set(key, set);
		}
		set.add(id);
	}

	private resolveIndex<K>(index: Map<K, Set<string>>, key: K): Node[] {
		const ids = index.get(key);
		if (!ids) return [];
		const nodes: Node[] = [];
		for (const id of ids) {
			const node = this.nodes.get(id);
			if (node) nodes.push(node);
		}
		return nodes;
	}
}

// ---------------------------------------------------------------------------
// JSONL importer — converts session entries into graph nodes + edges
// ---------------------------------------------------------------------------

export interface ImportResult {
	nodes: number;
	edges: number;
	sessionId: string;
}

/**
 * Import JSONL session entries into the store as a graph.
 *
 * Each entry becomes a Node. Sequential entries get `follows` edges.
 * User→Assistant pairs get `responds_to` edges.
 * Tool calls get `calls` + `result_of` edges.
 */
export function importSession(
	store: Store,
	sessionId: string,
	entries: Array<{
		type: string;
		id: string;
		parentId: string | null;
		message?: { role?: string; content?: unknown };
		[key: string]: unknown;
	}>,
): ImportResult {
	let nodeCount = 0;
	let edgeCount = 0;
	let prevNodeId: string | undefined;
	let lastUserNodeId: string | undefined;
	const toolCallNodes = new Map<string, string>(); // toolCallId → nodeId

	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (entry.type !== "message") continue;

		const msg = entry.message;
		if (!msg?.role) continue;

		const role = msg.role as string;
		const content = extractContent(msg);
		if (!content) continue;

		const kind = roleToKind(role);
		const node = createNode(kind, sessionId, i, content, role, entry.id);
		store.putNode(node);
		nodeCount++;

		// Sequential edge
		if (prevNodeId) {
			store.putEdge(createEdge(node.id, prevNodeId, "follows"));
			edgeCount++;
		}

		// Responds-to edge
		if (role === "assistant" && lastUserNodeId) {
			store.putEdge(createEdge(node.id, lastUserNodeId, "responds_to"));
			edgeCount++;
		}

		if (role === "user") lastUserNodeId = node.id;

		// Tool call edges
		if (role === "assistant" && Array.isArray(msg.content)) {
			for (const block of msg.content) {
				const b = block as Record<string, unknown>;
				if (b.type === "toolCall" && typeof b.id === "string") {
					const toolNode = createNode("tool_call", sessionId, i, JSON.stringify(b), role, `${entry.id}:${b.id}`);
					toolNode.meta = { toolName: b.name, toolCallId: b.id };
					store.putNode(toolNode);
					store.putEdge(createEdge(toolNode.id, node.id, "calls"));
					toolCallNodes.set(b.id as string, toolNode.id);
					nodeCount++;
					edgeCount++;
				}
			}
		}

		// Tool result edges
		if (role === "toolResult") {
			const toolCallId = (entry.message as Record<string, unknown>).toolCallId as string;
			if (toolCallId && toolCallNodes.has(toolCallId)) {
				store.putEdge(createEdge(node.id, toolCallNodes.get(toolCallId)!, "result_of"));
				edgeCount++;
			}
		}

		prevNodeId = node.id;
	}

	return { nodes: nodeCount, edges: edgeCount, sessionId };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createNode(
	kind: NodeKind,
	sessionId: string,
	seq: number,
	content: string,
	source: string,
	originalId?: string,
): Node {
	return {
		id: originalId ?? randomUUID(),
		kind,
		sessionId,
		seq,
		content,
		contentHash: simpleHash(content),
		tokenEstimate: Math.ceil(content.length / 4),
		source,
		createdAt: Date.now(),
	};
}

function createEdge(fromId: string, toId: string, kind: EdgeKind): Edge {
	return { id: randomUUID(), fromId, toId, kind, createdAt: Date.now() };
}

function roleToKind(role: string): NodeKind {
	switch (role) {
		case "user":
			return "user_message";
		case "assistant":
			return "assistant_message";
		case "toolResult":
			return "tool_result";
		default:
			return "system";
	}
}

function extractContent(msg: Record<string, unknown>): string | undefined {
	if (typeof msg.content === "string") return msg.content;
	if (Array.isArray(msg.content)) {
		const texts: string[] = [];
		for (const block of msg.content) {
			const b = block as Record<string, unknown>;
			if (b.type === "text" && typeof b.text === "string") texts.push(b.text);
			if (b.type === "thinking" && typeof b.thinking === "string") texts.push(b.thinking);
		}
		return texts.length > 0 ? texts.join("\n") : undefined;
	}
	return undefined;
}

function simpleHash(content: string): string {
	// Fast non-crypto hash for dedup — FNV-1a 32-bit
	let hash = 0x811c9dc5;
	for (let i = 0; i < content.length; i++) {
		hash ^= content.charCodeAt(i);
		hash = (hash * 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
	if (a.length !== b.length) return 0;
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}
	const denom = Math.sqrt(normA) * Math.sqrt(normB);
	return denom === 0 ? 0 : dot / denom;
}
