import { describe, expect, it, vi } from "vitest";
import { ScribeDiscourseProjection } from "../src/scribe-projection.js";

describe("ScribeDiscourseProjection", () => {
	it("projects one committed record with an idempotent operation identity", async () => {
		const calls: Array<{ action: string; params: Record<string, unknown> }> = [];
		const call = vi.fn(async (action: string, params: Record<string, unknown>) => {
			calls.push({ action, params });
			if (action === "get") throw new Error("missing");
			return "ok";
		});
		const projection = new ScribeDiscourseProjection(call, "mesh");
		await projection.project({
			sequence: 7,
			post: {
				id: "post-1",
				sequence: 7,
				operationId: "write-1",
				forumId: "default",
				topicId: "qa",
				threadId: "nesting",
				authorId: "alice",
				content: "finding",
				timestamp: 1,
				references: [],
			},
		});
		const message = calls.find((entry) => entry.action === "message_add");
		expect(message?.params).toMatchObject({
			parent: "ctx-thread-mesh-qa-nesting",
			author: "alice",
			scope: "mesh",
			operation_id: "scribe-mesh:7",
		});
	});
});
