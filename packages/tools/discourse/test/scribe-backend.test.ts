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
			text: "hello [[task-1]]",
			scope: "mesh",
		});
	});

	it("parses message_list stream on readThread", async () => {
		const call = vi.fn(async (action: string) => {
			if (action === "message_list") {
				return "msg-1\t1000\thello\n@bob: first\n---\nmsg-2\t2000\tmore\n@carol: second";
			}
			return "";
		});
		const backend = new ScribeDiscourseBackend(call, "mesh");
		const posts = await backend.readThread("qa", "nesting", 500);
		expect(posts).toHaveLength(2);
		expect(posts[0]).toMatchObject({ author: "bob", content: "first", timestamp: 1000 });
		expect(posts[1]).toMatchObject({ author: "carol", content: "second", timestamp: 2000 });
		expect(call).toHaveBeenCalledWith(
			"message_list",
			expect.objectContaining({ id: "ctx-thread-mesh-qa-nesting", mode: "children", since: 500 }),
		);
	});
});
