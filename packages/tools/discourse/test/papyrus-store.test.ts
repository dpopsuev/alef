import { describe, expect, it } from "vitest";
import {
	PapyrusArtifactReferenceVerifier,
	PapyrusDiscourseStore,
	type PapyrusOperationCall,
} from "../src/papyrus-store.js";

class FakePapyrusClient implements PapyrusOperationCall {
	readonly calls: Array<{ operation: string; input: Record<string, unknown> }> = [];
	result: unknown = 0;

	async call<Input extends Record<string, unknown>, Output>(
		operation: "artifact.show" | "discourse.store",
		input: Input,
	): Promise<Output> {
		this.calls.push({ operation, input });
		return this.result as Output;
	}
}

describe("Papyrus Discourse adapter", () => {
	it("maps every persistence operation through one authenticated namespaced authority", async () => {
		const client = new FakePapyrusClient();
		const store = new PapyrusDiscourseStore(client, "team-forum");
		const address = { forumId: "engineering", topicId: "reviews", threadId: "mesh" };
		const command = {
			schemaVersion: "discourse.command.v1" as const,
			operationId: "operation-1",
			authorId: "agent",
			content: "finding",
			...address,
		};
		await store.append(command, "post-1", 1);
		await store.readThread({ ...address, limit: 10 });
		await store.listTopics({ forumId: address.forumId, limit: 10 });
		await store.listThreads({ forumId: address.forumId, topicId: address.topicId, limit: 10 });
		await store.findOpenQuestions({ forumId: address.forumId, targetId: "agent", limit: 10 });
		await store.replay(2, 10);
		await store.snapshot({ forumId: address.forumId, afterSequence: 2, limit: 10 });
		await store.acknowledge("session-1", 2);
		await store.consumerCursor("session-1");
		await store.readProjectionOutbox("archive", 10);
		await store.acknowledgeProjection("archive", 2);
		await store.projectionCheckpoint("archive");
		await store.projectionPending("archive");
		await store.latestPostSequence();
		expect(client.calls.map((call) => call.input.action)).toEqual([
			"append",
			"read_thread",
			"list_topics",
			"list_threads",
			"open_questions",
			"replay",
			"snapshot",
			"acknowledge",
			"consumer_cursor",
			"read_projection_outbox",
			"acknowledge_projection",
			"projection_checkpoint",
			"projection_pending",
			"latest_post_sequence",
		]);
		expect(
			client.calls.every((call) => call.operation === "discourse.store" && call.input.store_id === "team-forum"),
		).toBe(true);
	});

	it("verifies artifact identity through a read-only graph operation", async () => {
		const client = new FakePapyrusClient();
		const verifier = new PapyrusArtifactReferenceVerifier(client);
		client.result = { kind: "task" };
		expect(await verifier.verify({ kind: "task", id: "task-1" })).toBe(true);
		expect(await verifier.verify({ kind: "doc", id: "task-1" })).toBe(false);
		client.result = null;
		expect(await verifier.verify({ kind: "task", id: "missing" })).toBe(false);
		expect(client.calls).toEqual([
			{ operation: "artifact.show", input: { id: "task-1" } },
			{ operation: "artifact.show", input: { id: "task-1" } },
			{ operation: "artifact.show", input: { id: "missing" } },
		]);
	});
});
