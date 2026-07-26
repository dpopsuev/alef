import {
	fauxAssistantMessage,
	registerFauxProvider,
} from "@dpopsuev/alef-ai/faux";
import { defineAdapter } from "@dpopsuev/alef-kernel/adapter";
import { createAgentLoop } from "@dpopsuev/alef-reasoner";
import { InMemoryRunJournal } from "@dpopsuev/alef-storage/memory/run-journal";
import { RunCommitted } from "../src/run-policy.js";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentSession } from "../src/create-agent-session.js";

describe("createAgentSession", () => {
	const cleanups: Array<() => void | Promise<void>> = [];

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	});

	it("rejects assembly without a model or reasoner", async () => {
		await expect(createAgentSession({ cwd: process.cwd(), adapters: [] })).rejects.toThrow(
			"createAgentSession requires model or llmAdapter",
		);
	});

	it("persists run lifecycle around host control", async () => {
		const faux = registerFauxProvider({ models: [{ id: "agent-session-run-test" }] });
		faux.setResponses([fauxAssistantMessage("durable reply")]);
		cleanups.push(() => faux.unregister());
		const journal = new InMemoryRunJournal();
		const runtime = await createAgentSession({
			cwd: process.cwd(),
			model: faux.getModel(),
			adapters: [],
			llmAdapter: createAgentLoop({ model: faux.getModel() }),
			runJournal: journal,
			sessionId: "session-1",
			runPolicy: { budget: { maxToolCalls: 2 }, externalEffects: "require-approval" },
		});
		cleanups.push(() => runtime.dispose());
		const runIds: string[] = [];
		runtime.eventHub.subscribe(RunCommitted, (event) => {
			if (event.scope.runId) runIds.push(event.scope.runId);
		});

		await expect(runtime.controller.send("test request", "human", 5_000)).resolves.toBe("durable reply");
		const runId = runIds[0];
		expect(runId).toBeDefined();
		expect(await journal.get(runId!)).toMatchObject({ state: "completed", policy: { budget: { maxToolCalls: 2 } } });
	});

	it("binds a persisted run to its triggering conversation without SessionStore", async () => {
		const faux = registerFauxProvider({ models: [{ id: "agent-session-conversation-test" }] });
		faux.setResponses([fauxAssistantMessage("durable reply")]);
		cleanups.push(() => faux.unregister());
		const journal = new InMemoryRunJournal();
		const conversationTrigger = {
			boardId: "acme",
			forumId: "sessions",
			topicId: "topic-1",
			threadId: "topic-1",
		};
		const runtime = await createAgentSession({
			cwd: process.cwd(),
			model: faux.getModel(),
			adapters: [],
			llmAdapter: createAgentLoop({ model: faux.getModel() }),
			runJournal: journal,
			sessionId: "session-1",
			runPolicy: { budget: {}, externalEffects: "allow" },
			conversationTrigger,
		});
		cleanups.push(() => runtime.dispose());
		const runIds: string[] = [];
		runtime.eventHub.subscribe(RunCommitted, (event) => {
			if (event.scope.runId) runIds.push(event.scope.runId);
		});

		await runtime.controller.send("test request", "human", 5_000);
		const runId = runIds[0]!;
		expect(await journal.get(runId)).toMatchObject({ sessionId: "session-1", conversationTrigger });
	});

	it("owns agent assembly, host control, adapters, and observer projection", async () => {
		const faux = registerFauxProvider({ models: [{ id: "agent-session-test" }] });
		faux.setResponses([fauxAssistantMessage("session reply")]);
		cleanups.push(() => faux.unregister());
		const adapter = defineAdapter("session-capability", {}, { description: "Test capability." });

		const runtime = await createAgentSession({
			cwd: process.cwd(),
			model: faux.getModel(),
			adapters: [adapter],
			llmAdapter: createAgentLoop({ model: faux.getModel() }),
		});
		cleanups.push(() => runtime.dispose());
		const events: string[] = [];
		runtime.observers.add((event) => events.push(event.type));

		const reply = await runtime.controller.send("test request", "human", 5_000);

		expect(reply).toBe("session reply");
		expect(runtime.agent.adapters.map((entry) => entry.name)).toEqual(
			expect.arrayContaining(["llm", "loop-detector", "progress-telemetry", "session-capability", "tools"]),
		);
		expect(runtime.agent.adapters.some((entry) => entry.name === "context.assembly")).toBe(false);
		expect(events).toContain("turn-complete");
	});
});
