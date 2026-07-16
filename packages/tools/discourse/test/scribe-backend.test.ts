import { describe, expect, it, vi } from "vitest";
import { ScribeDiscourseBackend } from "../src/scribe-backend.js";

describe("ScribeDiscourseBackend", () => {
	it("ensures containers then message_add on append", async () => {
		const calls: Array<{ action: string; params: Record<string, unknown> }> = [];
		const call = vi.fn(async (action: string, params: Record<string, unknown>) => {
			calls.push({ action, params });
			if (action === "get") throw new Error("missing");
			return "ok";
		});
		const backend = new ScribeDiscourseBackend(call, "mesh");
		const post = await backend.append("qa", "nesting", "alice", "hello [[task-1]]");
		expect(post).toMatchObject({ topic: "qa", thread: "nesting", author: "alice", content: "hello [[task-1]]" });
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

	it("parses message_list stream on readThread", async () => {
		const call = vi.fn(async (action: string) => {
			if (action === "message_list") {
				return [
					"msg-1\t1000\thello",
					'@bob: [[alef-discourse-meta {"id":"post-1"}]]',
					"first",
					"---",
					"msg-2\t2000\tmore",
					'@carol: [[alef-discourse-meta {"id":"post-2","replyToPostId":"post-1","references":["post-1"]}]]',
					"second",
				].join("\n");
			}
			return "";
		});
		const backend = new ScribeDiscourseBackend(call, "mesh");
		const posts = await backend.readThread("qa", "nesting", 500);
		expect(posts).toHaveLength(2);
		expect(posts[0]).toMatchObject({ id: "post-1", author: "bob", content: "first", timestamp: 1000 });
		expect(posts[1]).toMatchObject({
			id: "post-2",
			author: "carol",
			content: "second",
			timestamp: 2000,
			replyToPostId: "post-1",
			references: ["post-1"],
		});
		expect(call).toHaveBeenCalledWith(
			"message_list",
			expect.objectContaining({ id: "ctx-thread-mesh-qa-nesting", mode: "children", since: 500 }),
		);
	});
});
