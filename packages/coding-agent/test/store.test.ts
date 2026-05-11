/**
 * Tests for the unified store — graphable, embeddable, queryable, token-cheap.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
	cosineSimilarity,
	InMemoryStore,
	importSession,
	type Node,
	type Edge as StoreEdge,
} from "../src/board/store.js";

function makeNode(overrides: Partial<Node> = {}): Node {
	return {
		id: `node-${Math.random().toString(36).slice(2, 8)}`,
		kind: "user_message",
		sessionId: "s1",
		seq: 0,
		content: "test content",
		contentHash: "abc123",
		tokenEstimate: 3,
		source: "user",
		createdAt: Date.now(),
		...overrides,
	};
}

// ===========================================================================
// InMemoryStore — nodes
// ===========================================================================

describe("InMemoryStore — nodes", () => {
	let store: InMemoryStore;
	beforeEach(() => {
		store = new InMemoryStore();
	});

	it("put and get node", () => {
		const node = makeNode({ id: "n1", content: "hello" });
		store.putNode(node);
		expect(store.getNode("n1")?.content).toBe("hello");
	});

	it("getNodesByKind filters correctly", () => {
		store.putNode(makeNode({ id: "a", kind: "user_message" }));
		store.putNode(makeNode({ id: "b", kind: "assistant_message" }));
		store.putNode(makeNode({ id: "c", kind: "user_message" }));
		expect(store.getNodesByKind("user_message")).toHaveLength(2);
		expect(store.getNodesByKind("assistant_message")).toHaveLength(1);
	});

	it("getNodesBySession returns sorted by seq", () => {
		store.putNode(makeNode({ id: "c", sessionId: "s1", seq: 2 }));
		store.putNode(makeNode({ id: "a", sessionId: "s1", seq: 0 }));
		store.putNode(makeNode({ id: "b", sessionId: "s1", seq: 1 }));
		const nodes = store.getNodesBySession("s1");
		expect(nodes.map((n) => n.id)).toEqual(["a", "b", "c"]);
	});

	it("getNodesBySource filters correctly", () => {
		store.putNode(makeNode({ id: "a", source: "user" }));
		store.putNode(makeNode({ id: "b", source: "jade" }));
		expect(store.getNodesBySource("jade")).toHaveLength(1);
	});

	it("nodeCount reports correctly", () => {
		store.putNode(makeNode({ id: "a" }));
		store.putNode(makeNode({ id: "b" }));
		expect(store.nodeCount()).toBe(2);
	});
});

// ===========================================================================
// InMemoryStore — edges
// ===========================================================================

describe("InMemoryStore — edges", () => {
	let store: InMemoryStore;
	beforeEach(() => {
		store = new InMemoryStore();
	});

	it("put and get edges", () => {
		const edge: StoreEdge = { id: "e1", fromId: "a", toId: "b", kind: "follows", createdAt: Date.now() };
		store.putEdge(edge);
		expect(store.getEdgesFrom("a")).toHaveLength(1);
		expect(store.getEdgesTo("b")).toHaveLength(1);
	});

	it("getEdgesFrom filters by kind", () => {
		store.putEdge({ id: "e1", fromId: "a", toId: "b", kind: "follows", createdAt: Date.now() });
		store.putEdge({ id: "e2", fromId: "a", toId: "c", kind: "responds_to", createdAt: Date.now() });
		expect(store.getEdgesFrom("a", "follows")).toHaveLength(1);
		expect(store.getEdgesFrom("a")).toHaveLength(2);
	});

	it("edgeCount reports correctly", () => {
		store.putEdge({ id: "e1", fromId: "a", toId: "b", kind: "follows", createdAt: Date.now() });
		expect(store.edgeCount()).toBe(1);
	});
});

// ===========================================================================
// InMemoryStore — embeddings and similarity
// ===========================================================================

describe("InMemoryStore — embeddings", () => {
	let store: InMemoryStore;
	beforeEach(() => {
		store = new InMemoryStore();
	});

	it("set and get embedding", () => {
		const vec = new Float32Array([1, 0, 0]);
		store.setEmbedding("n1", vec);
		expect(store.getEmbedding("n1")).toEqual(vec);
		expect(store.getEmbedding("missing")).toBeUndefined();
	});

	it("similarTo finds nearest neighbors", () => {
		store.putNode(makeNode({ id: "a", content: "auth" }));
		store.putNode(makeNode({ id: "b", content: "database" }));
		store.putNode(makeNode({ id: "c", content: "authentication" }));

		// Simulate embeddings: a and c are similar (auth-related), b is different
		store.setEmbedding("a", new Float32Array([1, 0, 0]));
		store.setEmbedding("b", new Float32Array([0, 1, 0]));
		store.setEmbedding("c", new Float32Array([0.9, 0.1, 0]));

		const query = new Float32Array([1, 0, 0]); // query about auth
		const results = store.similarTo(query, 2);

		expect(results).toHaveLength(2);
		expect(results[0].node.id).toBe("a"); // exact match
		expect(results[1].node.id).toBe("c"); // close match
		expect(results[0].score).toBeGreaterThan(results[1].score);
	});

	it("similarTo respects filter", () => {
		store.putNode(makeNode({ id: "a", kind: "user_message" }));
		store.putNode(makeNode({ id: "b", kind: "assistant_message" }));

		store.setEmbedding("a", new Float32Array([1, 0]));
		store.setEmbedding("b", new Float32Array([1, 0]));

		const results = store.similarTo(new Float32Array([1, 0]), 10, (n) => n.kind === "assistant_message");
		expect(results).toHaveLength(1);
		expect(results[0].node.id).toBe("b");
	});
});

// ===========================================================================
// Cosine similarity
// ===========================================================================

describe("cosineSimilarity", () => {
	it("identical vectors = 1.0", () => {
		const v = new Float32Array([1, 2, 3]);
		expect(cosineSimilarity(v, v)).toBeCloseTo(1.0);
	});

	it("orthogonal vectors = 0.0", () => {
		const a = new Float32Array([1, 0, 0]);
		const b = new Float32Array([0, 1, 0]);
		expect(cosineSimilarity(a, b)).toBeCloseTo(0.0);
	});

	it("opposite vectors = -1.0", () => {
		const a = new Float32Array([1, 0]);
		const b = new Float32Array([-1, 0]);
		expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0);
	});

	it("zero vector = 0.0", () => {
		const a = new Float32Array([1, 2]);
		const b = new Float32Array([0, 0]);
		expect(cosineSimilarity(a, b)).toBe(0);
	});

	it("different lengths = 0.0", () => {
		const a = new Float32Array([1, 2]);
		const b = new Float32Array([1, 2, 3]);
		expect(cosineSimilarity(a, b)).toBe(0);
	});
});

// ===========================================================================
// Search
// ===========================================================================

describe("InMemoryStore — search", () => {
	it("full text search across nodes", () => {
		const store = new InMemoryStore();
		store.putNode(makeNode({ id: "a", content: "JWT token validation" }));
		store.putNode(makeNode({ id: "b", content: "session middleware" }));
		store.putNode(makeNode({ id: "c", content: "JWT refresh logic" }));

		expect(store.search("JWT")).toHaveLength(2);
		expect(store.search("middleware")).toHaveLength(1);
		expect(store.search("nonexistent")).toHaveLength(0);
	});

	it("search respects limit", () => {
		const store = new InMemoryStore();
		for (let i = 0; i < 50; i++) {
			store.putNode(makeNode({ id: `n${i}`, content: `match item ${i}` }));
		}
		expect(store.search("match", 5)).toHaveLength(5);
	});
});

// ===========================================================================
// JSONL import
// ===========================================================================

describe("importSession", () => {
	it("imports user and assistant messages as nodes with edges", () => {
		const store = new InMemoryStore();
		const entries = [
			{ type: "message", id: "e1", parentId: null, message: { role: "user", content: "fix auth" } },
			{
				type: "message",
				id: "e2",
				parentId: "e1",
				message: { role: "assistant", content: [{ type: "text", text: "I will fix auth" }] },
			},
		];

		const result = importSession(store, "session-1", entries);
		expect(result.nodes).toBe(2);
		expect(result.edges).toBe(2); // follows + responds_to

		const nodes = store.getNodesBySession("session-1");
		expect(nodes).toHaveLength(2);
		expect(nodes[0].kind).toBe("user_message");
		expect(nodes[1].kind).toBe("assistant_message");
	});

	it("imports tool calls with calls + result_of edges", () => {
		const store = new InMemoryStore();
		const entries = [
			{ type: "message", id: "e1", parentId: null, message: { role: "user", content: "edit the file" } },
			{
				type: "message",
				id: "e2",
				parentId: "e1",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "Editing..." },
						{ type: "toolCall", id: "tc1", name: "file_edit", arguments: { path: "a.ts" } },
					],
				},
			},
			{
				type: "message",
				id: "e3",
				parentId: "e2",
				message: { role: "toolResult", toolCallId: "tc1", content: [{ type: "text", text: "done" }] },
			},
		];

		const result = importSession(store, "s1", entries);
		expect(result.nodes).toBe(4); // user + assistant + tool_call + tool_result
		expect(result.edges).toBeGreaterThanOrEqual(4); // follows chain + responds_to + calls + result_of
	});

	it("skips non-message entries", () => {
		const store = new InMemoryStore();
		const entries = [
			{ type: "thinking_level_change", id: "e0", parentId: null, thinkingLevel: "high" },
			{ type: "message", id: "e1", parentId: null, message: { role: "user", content: "hello" } },
			{ type: "model_change", id: "e2", parentId: "e1", provider: "anthropic", modelId: "opus" },
		];

		const result = importSession(store, "s1", entries);
		expect(result.nodes).toBe(1); // only the message
	});

	it("handles thinking content in assistant messages", () => {
		const store = new InMemoryStore();
		const entries = [
			{
				type: "message",
				id: "e1",
				parentId: null,
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "Let me analyze..." },
						{ type: "text", text: "Here is my answer" },
					],
				},
			},
		];

		const result = importSession(store, "s1", entries);
		expect(result.nodes).toBe(1);
		const node = store.getNodesBySession("s1")[0];
		expect(node.content).toContain("Let me analyze...");
		expect(node.content).toContain("Here is my answer");
	});

	it("token estimate is roughly content.length / 4", () => {
		const store = new InMemoryStore();
		const content = "A".repeat(400);
		const entries = [{ type: "message", id: "e1", parentId: null, message: { role: "user", content } }];

		importSession(store, "s1", entries);
		const node = store.getNodesBySession("s1")[0];
		expect(node.tokenEstimate).toBe(100);
	});
});
