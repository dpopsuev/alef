import { describe, expect, it, vi } from "vitest";
import type { DiscourseService } from "../src/service.js";
import type { AppendPostCommand, SubscriptionBatch } from "../src/types.js";

export interface DiscourseConformanceHarness {
	readonly service: DiscourseService;
}
export type DiscourseConformanceFactory = (options?: { eventRetention?: number }) => DiscourseConformanceHarness;
let operationCounter = 0;
function command(overrides: Partial<AppendPostCommand> = {}): AppendPostCommand {
	return {
		schemaVersion: "discourse.command.v1",
		operationId: `operation-${++operationCounter}`,
		forumId: "engineering",
		topicId: "reviews",
		threadId: "nesting",
		authorId: "alice",
		content: "finding",
		...overrides,
	};
}

export function discourseConformanceSuite(createHarness: DiscourseConformanceFactory): void {
	describe("Discourse capability conformance", () => {
		it("appends immutable posts and replies only within one thread", async () => {
			const { service } = createHarness();
			const root = await service.post(command());
			const reply = await service.post(command({ authorId: "bob", content: "reply", replyToPostId: root.post.id }));
			expect(reply.post.replyToPostId).toBe(root.post.id);
			await expect(service.post(command({ threadId: "other", replyToPostId: root.post.id }))).rejects.toThrow(
				"same thread",
			);
			await expect(service.post(command({ replyToPostId: "missing" }))).rejects.toThrow("not found");
		});
		it("replays duplicate operations and rejects conflicting reuse", async () => {
			const { service } = createHarness();
			const input = command();
			const first = await service.post(input);
			expect(await service.post(input)).toEqual({ post: first.post, replayed: true });
			await expect(service.post({ ...input, content: "changed" })).rejects.toThrow("operation conflict");
		});
		it("orders and bounds thread, topic, and snapshot reads", async () => {
			const { service } = createHarness();
			for (let index = 0; index < 4; index += 1) await service.post(command({ content: `post-${index}` }));
			const first = await service.readThread({
				forumId: "engineering",
				topicId: "reviews",
				threadId: "nesting",
				limit: 2,
			});
			expect(first.items.map((post) => post.content)).toEqual(["post-0", "post-1"]);
			expect(first).toMatchObject({ truncated: true, completeness: "truncated" });
			const second = await service.readThread({
				forumId: "engineering",
				topicId: "reviews",
				threadId: "nesting",
				afterSequence: first.nextSequence,
				limit: 2,
			});
			expect(second.items.map((post) => post.content)).toEqual(["post-2", "post-3"]);
			expect((await service.listTopics({ forumId: "engineering", limit: 1 })).items[0]).toMatchObject({
				postCount: 4,
			});
			expect((await service.snapshot({ forumId: "engineering", limit: 2 })).posts.truncated).toBe(true);
		});
		it("matches open questions with answers and optional targets", async () => {
			const { service } = createHarness();
			await service.post(
				command({ content: { type: "question", responseId: "q-1", targetId: "bob", text: "why?" } }),
			);
			await service.post(
				command({ content: { type: "question", responseId: "q-2", targetId: "carol", text: "where?" } }),
			);
			expect((await service.findOpenQuestions({ targetId: "bob" })).items.map((entry) => entry.responseId)).toEqual([
				"q-1",
			]);
			await service.post(command({ content: { type: "answer", responseId: "q-1", text: "because" } }));
			expect((await service.findOpenQuestions({ targetId: "bob" })).items).toEqual([]);
		});
		it("pushes sequenced events, resumes acknowledgments, and signals replay gaps", async () => {
			const { service } = createHarness({ eventRetention: 4 });
			const live: SubscriptionBatch[] = [];
			const handle = await service.subscribe({ consumerId: "reviewer" }, (batch) => live.push(batch));
			await service.post(command());
			const initial = live[0];
			if (!initial) throw new Error("missing live event batch");
			expect(initial.replayed).toBe(false);
			expect(initial.events.map((event) => event.type)).toEqual(["post-added", "thread-changed"]);
			const latest = initial.events.at(-1);
			if (!latest) throw new Error("missing live event");
			expect(await service.acknowledge("reviewer", latest.sequence)).toBe(latest.sequence);
			handle.close();
			await service.post(command());
			const replayed: SubscriptionBatch[] = [];
			await service.subscribe({ consumerId: "reviewer" }, (batch) => replayed.push(batch));
			expect(replayed[0]?.replayed).toBe(true);
			await service.post(command());
			await service.post(command());
			const expired: SubscriptionBatch[] = [];
			await service.subscribe({ consumerId: "stale", afterSequence: 1 }, (batch) => expired.push(batch));
			expect(expired[0]?.events[0]?.type).toBe("subscription-resync-required");
		});
		it("allocates unique monotonic sequences for concurrent writers", async () => {
			const { service } = createHarness();
			const posts = await Promise.all(
				Array.from({ length: 20 }, (_, index) => service.post(command({ content: index }))),
			);
			const sequences = posts.map((result) => result.post.sequence);
			expect(new Set(sequences).size).toBe(20);
			expect([...sequences].sort((left, right) => left - right)).toEqual(sequences);
		});
		it("rejects malformed, oversized, and unverified external input", async () => {
			const { service } = createHarness();
			await expect(service.post(command({ forumId: "" }))).rejects.toThrow();
			await expect(service.post(command({ content: "x".repeat(70_000) }))).rejects.toThrow("cannot exceed");
			await expect(service.post(command({ references: [{ kind: "task", id: "unknown" }] }))).rejects.toThrow(
				"not verified",
			);
			expect(() => service.readThread({ forumId: "f", topicId: "t", threadId: "h", limit: 101 })).toThrow("limit");
		});
		it("checkpoints projection progress and exposes bounded failure", async () => {
			const { service } = createHarness();
			await service.post(command());
			await service.post(command());
			const projected: number[] = [];
			expect(
				await service.project({
					id: "archive",
					project: async (record) => {
						projected.push(record.sequence);
					},
				}),
			).toMatchObject({ state: "current", pending: 0 });
			expect(projected).toHaveLength(2);
			await service.project({
				id: "archive",
				project: async (record) => {
					projected.push(record.sequence);
				},
			});
			expect(projected).toHaveLength(2);
			const failing = vi.fn(async () => {
				throw new Error("offline");
			});
			const failedService = createHarness().service;
			await failedService.post(command());
			expect(await failedService.project({ id: "archive", project: failing })).toMatchObject({
				state: "failed",
				failure: "offline",
			});
			expect(failing).toHaveBeenCalledTimes(3);
		});
	});
}
