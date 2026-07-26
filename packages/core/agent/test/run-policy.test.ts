import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { CommandRouter, defineCommand } from "@dpopsuev/alef-kernel/capabilities";
import { EventHub } from "@dpopsuev/alef-kernel/events";
import { makeTestDatabase } from "@dpopsuev/alef-storage/sqlite/database";
import { SqliteRunJournal } from "@dpopsuev/alef-storage/sqlite/run-journal";
import { DurableRunPolicy, RunCommitted, RunPolicyError, RunWaitingForHumanError } from "../src/run-policy.js";

const Write = defineCommand({
	name: "fs.write",
	version: 1,
	input: z.object({ path: z.string(), content: z.string() }),
	output: z.object({ written: z.string() }),
	effect: "external",
});

const Read = defineCommand({
	name: "fs.read",
	version: 1,
	input: z.object({ path: z.string() }),
	output: z.object({ content: z.string() }),
	effect: "none",
});

describe("DurableRunPolicy", { tags: ["unit"] }, () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) cleanup();
	});

	it("persists waiting-human before notification and resumes an approved edited effect after restart", async () => {
		const database = await makeTestDatabase();
		cleanups.push(database.cleanup);
		const journal = new SqliteRunJournal(database.client);
		const eventHub = new EventHub({ capacity: 32, concurrency: 1 });
		const observed: Array<{ type: string; sequence: number; state: string }> = [];
		eventHub.subscribe(RunCommitted, (event) => {
			observed.push({ type: event.payload.type, sequence: event.payload.sequence, state: event.payload.snapshot.state });
		});
		const firstPolicy = new DurableRunPolicy(journal, eventHub);
		await firstPolicy.start("run-1", "session-1", {
			budget: { maxToolCalls: 2 },
			externalEffects: "require-approval",
		});
		const execute = vi.fn(({ input }: { input: { path: string; content: string } }) =>
			Promise.resolve({ written: input.content }),
		);
		const firstRouter = new CommandRouter(firstPolicy);
		firstRouter.register("fs", Write, execute);

		let proposalId = "";
		try {
			await firstRouter.execute(Write, { path: "a.txt", content: "first" }, { runId: "run-1" });
		} catch (error) {
			expect(error).toBeInstanceOf(RunWaitingForHumanError);
			proposalId = (error as RunWaitingForHumanError).proposalId;
		}
		expect(execute).not.toHaveBeenCalled();
		expect(await journal.get("run-1")).toMatchObject({ state: "waiting-human", pendingEffectId: proposalId });
		expect(observed.at(-1)).toMatchObject({ type: "run.waiting-human", state: "waiting-human" });

		const resumedPolicy = new DurableRunPolicy(new SqliteRunJournal(database.client), eventHub);
		await resumedPolicy.approveEffect("run-1", proposalId, "operator-1", {
			path: "a.txt",
			content: "edited",
		});
		const resumedRouter = new CommandRouter(resumedPolicy);
		resumedRouter.register("fs", Write, execute);
		await expect(
			resumedRouter.execute(
				Write,
				{ path: "ignored.txt", content: "ignored" },
				{ runId: "run-1", effectProposalId: proposalId },
			),
		).resolves.toEqual({ written: "edited" });

		expect(execute).toHaveBeenCalledWith(expect.objectContaining({ input: { path: "a.txt", content: "edited" } }));
		expect(await journal.get("run-1")).toMatchObject({ state: "running", budget: { toolCalls: 1 } });
		expect(await journal.getEffectProposal("run-1", proposalId)).toMatchObject({ status: "completed" });
		expect(observed.map((event) => event.sequence)).toEqual([...observed.map((event) => event.sequence)].sort((a, b) => a - b));
		eventHub.close();
	});

	it("persists budget use and fails closed after restart", async () => {
		const database = await makeTestDatabase();
		cleanups.push(database.cleanup);
		const journal = new SqliteRunJournal(database.client);
		const firstPolicy = new DurableRunPolicy(journal);
		await firstPolicy.start("run-2", "session-1", {
			budget: { maxToolCalls: 1 },
			externalEffects: "require-approval",
		});
		const firstRouter = new CommandRouter(firstPolicy);
		firstRouter.register("fs", Read, ({ input }) => Promise.resolve({ content: input.path }));
		await firstRouter.execute(Read, { path: "first" }, { runId: "run-2" });

		const restartedPolicy = new DurableRunPolicy(new SqliteRunJournal(database.client));
		const restartedRouter = new CommandRouter(restartedPolicy);
		restartedRouter.register("fs", Read, ({ input }) => Promise.resolve({ content: input.path }));
		await expect(restartedRouter.execute(Read, { path: "second" }, { runId: "run-2" })).rejects.toMatchObject({
			code: "budget-exceeded",
		});
		expect(await journal.get("run-2")).toMatchObject({ state: "failed", budget: { toolCalls: 1 } });
	});

	it("never treats an expired human decision as approval", async () => {
		const database = await makeTestDatabase();
		cleanups.push(database.cleanup);
		const journal = new SqliteRunJournal(database.client);
		const policy = new DurableRunPolicy(journal);
		await policy.start("run-3", "session-1", { budget: {}, externalEffects: "require-approval" });
		const execute = vi.fn(() => Promise.resolve({ written: "no" }));
		const router = new CommandRouter(policy);
		router.register("fs", Write, execute);
		let proposalId = "";
		await router.execute(Write, { path: "a", content: "b" }, { runId: "run-3" }).catch((error: unknown) => {
			proposalId = (error as RunWaitingForHumanError).proposalId;
		});

		await policy.expireEffect("run-3", proposalId);
		await expect(
			router.execute(Write, { path: "a", content: "b" }, { runId: "run-3", effectProposalId: proposalId }),
		).rejects.toBeInstanceOf(RunPolicyError);
		expect(execute).not.toHaveBeenCalled();
		expect(await journal.getEffectProposal("run-3", proposalId)).toMatchObject({ status: "expired" });
	});
});
