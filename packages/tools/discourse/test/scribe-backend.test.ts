import { describe, expect, it, vi } from "vitest";
import { InMemoryDiscourseStore } from "../src/memory-store.js";
import { ScribeDiscourseMirror } from "../src/scribe-backend.js";

describe("ScribeDiscourseMirror", () => {
	it("writes store first then mirrors via message_add", async () => {
		const store = new InMemoryDiscourseStore();
		const calls: Array<{ action: string; params: Record<string, unknown> }> = [];
		const call = vi.fn(async (action: string, params: Record<string, unknown>) => {
			calls.push({ action, params });
			if (action === "get") throw new Error("missing");
			return "ok";
		});
		const backend = new ScribeDiscourseMirror(store, call, "mesh");
		const post = await backend.append("qa", "nesting", "alice", "hello [[task-1]]");
		expect(post).toMatchObject({ topic: "qa", thread: "nesting", author: "alice", content: "hello [[task-1]]" });
		expect(store.readThread("qa", "nesting")).toHaveLength(1);
		expect(calls.some((c) => c.action === "create" && c.params.id === "ctx-topic-mesh-qa")).toBe(true);
		expect(calls.some((c) => c.action === "create" && c.params.id === "ctx-thread-mesh-qa-nesting")).toBe(true);
		const msg = calls.find((c) => c.action === "message_add");
		expect(msg?.params).toMatchObject({
			parent: "ctx-thread-mesh-qa-nesting",
			author: "alice",
			scope: "mesh",
		});
		expect(String(msg?.params.text)).toContain("hello [[task-1]]");
		expect(String(msg?.params.text)).toContain("[[alef-discourse-meta");
	});

	it("reads from the inner store, not Scribe", async () => {
		const store = new InMemoryDiscourseStore();
		store.append("qa", "nesting", "bob", "first");
		const call = vi.fn(async () => {
			throw new Error("scribe should not be read");
		});
		const backend = new ScribeDiscourseMirror(store, call, "mesh");
		const posts = await backend.readThread("qa", "nesting");
		expect(posts).toHaveLength(1);
		expect(posts[0]).toMatchObject({ author: "bob", content: "first" });
		expect(call).not.toHaveBeenCalled();
	});
});
