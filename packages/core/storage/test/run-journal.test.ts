import { afterEach, describe, expect, it } from "vitest";
import { SqliteRunJournal } from "../src/sqlite/run-journal.js";
import { makeTestDatabase } from "../src/sqlite/database.js";

describe("SqliteRunJournal", { tags: ["unit"] }, () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) cleanup();
	});

	it("atomically sequences events and updates the durable snapshot", async () => {
		const database = await makeTestDatabase();
		cleanups.push(database.cleanup);
		const journal = new SqliteRunJournal(database.client);
		const created = await journal.create({
			runId: "run-1",
			sessionId: "session-1",
			policy: { budget: { maxToolCalls: 2, maxElapsedMs: 10_000 }, externalEffects: "require-approval" },
		});

		expect(created).toMatchObject({ state: "created", sequence: 1, budget: { toolCalls: 0 } });
		const started = await journal.append("run-1", created.sequence, { type: "run.started", payload: {} });
		expect(started.snapshot).toMatchObject({ state: "running", sequence: 2 });

		await expect(
			journal.append("run-1", created.sequence, { type: "run.completed", payload: {} }),
		).rejects.toMatchObject({ code: "sequence-conflict" });
		expect((await journal.get("run-1"))?.state).toBe("running");
		expect((await journal.events("run-1", 0, 10)).map((event) => event.sequence)).toEqual([1, 2]);
	});

	it("persists effect proposals independently from process memory", async () => {
		const database = await makeTestDatabase();
		cleanups.push(database.cleanup);
		const first = new SqliteRunJournal(database.client);
		const created = await first.create({
			runId: "run-2",
			sessionId: "session-1",
			policy: { budget: {}, externalEffects: "require-approval" },
		});
		const started = await first.append("run-2", created.sequence, { type: "run.started", payload: {} });
		const proposed = await first.append("run-2", started.snapshot.sequence, {
			type: "run.effect-proposed",
			payload: {
				proposalId: "proposal-1",
				commandName: "fs.write",
				commandVersion: 1,
				input: { path: "a.txt", content: "first" },
			},
		});
		await first.append("run-2", proposed.snapshot.sequence, {
			type: "run.waiting-human",
			payload: { proposalId: "proposal-1" },
		});

		const reopened = new SqliteRunJournal(database.client);
		expect(await reopened.get("run-2")).toMatchObject({ state: "waiting-human", pendingEffectId: "proposal-1" });
		expect(await reopened.getEffectProposal("run-2", "proposal-1")).toMatchObject({
			status: "pending",
			input: { path: "a.txt", content: "first" },
		});
	});

	it("binds a run to its triggering conversation independent of the session", async () => {
		const database = await makeTestDatabase();
		cleanups.push(database.cleanup);
		const journal = new SqliteRunJournal(database.client);
		const conversationTrigger = {
			boardId: "acme",
			forumId: "sessions",
			topicId: "topic-1",
			threadId: "topic-1",
			triggeringPostId: "post-1",
		};
		const created = await journal.create({
			runId: "run-3",
			sessionId: "session-1",
			policy: { budget: {}, externalEffects: "allow" },
			conversationTrigger,
		});
		expect(created.conversationTrigger).toEqual(conversationTrigger);

		const reopened = new SqliteRunJournal(database.client);
		expect((await reopened.get("run-3"))?.conversationTrigger).toEqual(conversationTrigger);
	});
});
