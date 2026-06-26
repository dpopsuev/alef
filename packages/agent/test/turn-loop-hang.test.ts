/**
 * Turn loop integration tests — real adapters, faux LLM, actual waitForToolResult path.
 * BlueprintHarness uses ScriptedReasoner and bypasses waitForToolResult; these don't.
 */

import { defineAdapter, typedAction } from "@dpopsuev/alef-kernel/adapter";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@dpopsuev/alef-llm/faux";
import { createAgentLoop } from "@dpopsuev/alef-reasoner";
import { Agent, AgentController } from "@dpopsuev/alef-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

const disposes: Array<() => void> = [];
afterEach(() => {
	for (const d of disposes.splice(0)) d();
});

function makeAgent(opts: { timeoutMs?: number } = {}) {
	const faux = registerFauxProvider();
	const agent = new Agent();
	agent.load(
		createAgentLoop({
			model: faux.getModel(),
			apiKey: "faux-key",
		}),
	);
	const controller = new AgentController(agent);
	disposes.push(() => agent.dispose());
	return { faux, agent, controller, timeoutMs: opts.timeoutMs ?? 3_000 };
}

describe("turn loop — slow adapter", { tags: ["unit"] }, () => {
	it("controller.send resolves when the tool completes before the deadline", async () => {
		const { faux, agent, controller, timeoutMs } = makeAgent({ timeoutMs: 5_000 });

		const slowAdapter = defineAdapter(
			"slow",
			{
				command: {
					"slow.op": typedAction(
						{ name: "slow.op", description: "A slow op", inputSchema: z.object({}) },
						async () => {
							await new Promise<void>((r) => setTimeout(r, 500));
							return { result: "slow-done" };
						},
					),
				},
			},
			{ description: "Slow adapter for testing.", directives: ["Use slow.op when asked."] },
		);

		agent.load(slowAdapter);
		await agent.ready();

		faux.setResponses([fauxAssistantMessage([fauxToolCall("slow.op", {})]), fauxAssistantMessage("all done")]);

		const reply = await controller.send("run the slow op", "human", timeoutMs);
		expect(reply).toBe("all done");
	}, 8_000);
});

describe("turn loop — hanging adapter", { tags: ["unit"] }, () => {
	it("controller.send rejects at its timeout when the tool never publishes an event message", async () => {
		const { faux, agent, controller } = makeAgent();
		const SEND_TIMEOUT_MS = 1_500;

		const hangAdapter = defineAdapter(
			"hang",
			{
				command: {
					"hang.op": typedAction(
						{ name: "hang.op", description: "A hanging op", inputSchema: z.object({}) },
						async () => {
							await new Promise<Record<string, unknown>>(() => {});
							return {};
						},
					),
				},
			},
			{ description: "Hanging adapter for testing.", directives: ["Use hang.op when asked."] },
		);

		agent.load(hangAdapter);
		await agent.ready();

		faux.setResponses([fauxAssistantMessage([fauxToolCall("hang.op", {})])]);

		const start = Date.now();
		await expect(controller.send("run the hanging op", "human", SEND_TIMEOUT_MS)).rejects.toThrow(/timed out/i);

		const elapsed = Date.now() - start;
		expect(elapsed).toBeGreaterThan(SEND_TIMEOUT_MS - 200);
		expect(elapsed).toBeLessThan(SEND_TIMEOUT_MS + 1_000);
	}, 6_000);
});

describe("turn loop — error adapter", { tags: ["unit"] }, () => {
	it("controller.send resolves when the adapter throws and the LLM handles the error", async () => {
		const { faux, agent, controller, timeoutMs } = makeAgent({ timeoutMs: 5_000 });

		const errorAdapter = defineAdapter(
			"err",
			{
				command: {
					"err.op": typedAction(
						{ name: "err.op", description: "An op that fails", inputSchema: z.object({}) },
						async () => {
							throw new Error("adapter exploded");
						},
					),
				},
			},
			{ description: "Error adapter for testing.", directives: ["Use err.op when asked."] },
		);

		agent.load(errorAdapter);
		await agent.ready();

		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("err.op", {})]),
			fauxAssistantMessage("I see the tool failed"),
		]);

		const reply = await controller.send("run the failing op", "human", timeoutMs);
		expect(reply).toBe("I see the tool failed");
	}, 8_000);
});

describe("turn loop — schema validation failure", { tags: ["unit"] }, () => {
	it("turn completes when LLM sends wrong type for a schema field", async () => {
		const { faux, agent, controller, timeoutMs } = makeAgent({ timeoutMs: 3_000 });

		const strictAdapter = defineAdapter(
			"strict",
			{
				command: {
					"strict.op": typedAction(
						{
							name: "strict.op",
							description: "Op requiring a numeric count.",
							inputSchema: z.object({ count: z.number() }),
						},
						async () => ({ result: "ok" }),
					),
				},
			},
			{ description: "Strict schema adapter.", directives: ["Use strict.op when asked."] },
		);

		agent.load(strictAdapter);
		await agent.ready();

		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("strict.op", { count: "3" })]),
			fauxAssistantMessage("I see the validation failed"),
		]);

		const reply = await controller.send("call strict.op", "human", timeoutMs);
		expect(reply).toBe("I see the validation failed");
	}, 6_000);
});
