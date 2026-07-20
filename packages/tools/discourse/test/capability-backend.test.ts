import { afterEach, describe, expect, it, vi } from "vitest";
import { CapabilityDiscourseBackend } from "../src/capability-backend.js";

afterEach(() => vi.restoreAllMocks());

describe("capability-backed adapter facade", () => {
	it("preserves established post, read, and list results", async () => {
		const backend = new CapabilityDiscourseBackend();
		const root = await backend.append("reviews", "nesting", "alice", "root", { operationId: "root-operation" });
		const reply = await backend.append("reviews", "nesting", "bob", "reply", {
			operationId: "reply-operation",
			replyToPostId: root.id,
		});
		expect(reply.replyToPostId).toBe(root.id);
		expect(await backend.readThread("reviews", "nesting")).toHaveLength(2);
		expect(await backend.listTopics()).toEqual(["reviews"]);
		expect(await backend.listThreads("reviews")).toEqual(["nesting"]);
	});

	it("uses operation identity for idempotency", async () => {
		const backend = new CapabilityDiscourseBackend();
		const first = await backend.append("reviews", "nesting", "alice", "same", { operationId: "same-operation" });
		const replay = await backend.append("reviews", "nesting", "alice", "same", { operationId: "same-operation" });
		expect(replay.id).toBe(first.id);
		expect(await backend.readThread("reviews", "nesting")).toHaveLength(1);
	});

	it("delivers equal-timestamp posts through sequenced push state", async () => {
		vi.spyOn(Date, "now").mockReturnValue(1_000);
		const backend = new CapabilityDiscourseBackend();
		await backend.append("updates", "status", "alice", "ready", { operationId: "equal-time" });
		const posts = await backend.readNewPosts(1_000);
		expect(posts).toHaveLength(1);
		expect(posts[0]?.content).toBe("ready");
	});

	it("rejects replies across threads before committing", async () => {
		const backend = new CapabilityDiscourseBackend();
		const root = await backend.append("reviews", "nesting", "alice", "root", { operationId: "root" });
		await expect(
			backend.append("reviews", "naming", "bob", "reply", {
				operationId: "cross-thread",
				replyToPostId: root.id,
			}),
		).rejects.toThrow("same thread");
		expect(await backend.readThread("reviews", "naming")).toEqual([]);
	});
});
