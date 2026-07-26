import {
	fauxAssistantMessage,
	registerFauxProvider,
} from "@dpopsuev/alef-ai/faux";
import { defineAdapter } from "@dpopsuev/alef-kernel/adapter";
import { createAgentLoop } from "@dpopsuev/alef-reasoner";
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
