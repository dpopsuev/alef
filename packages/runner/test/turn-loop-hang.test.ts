/**
 * Turn loop integration tests — real organs, faux LLM, actual waitForToolResult path.
 * BlueprintHarness uses ScriptedReasoner and bypasses waitForToolResult; these don't.
 */

import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@dpopsuev/alef-ai";
import { defineOrgan, typedAction } from "@dpopsuev/alef-kernel";
import { DialogOrgan } from "@dpopsuev/alef-organ-dialog";
import { Cerebrum } from "@dpopsuev/alef-organ-llm";
import { Agent } from "@dpopsuev/alef-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

const disposes: Array<() => void> = [];
afterEach(() => {
	for (const d of disposes.splice(0)) d();
});

function makeAgent(opts: { timeoutMs?: number } = {}) {
	const faux = registerFauxProvider();
	const agent = new Agent();
	const dialog = new DialogOrgan({ sink: () => {} });
	agent.load(dialog).load(new Cerebrum({ model: faux.getModel(), apiKey: "faux-key", getTools: () => agent.tools }));
	disposes.push(() => agent.dispose());
	return { faux, agent, dialog, timeoutMs: opts.timeoutMs ?? 3_000 };
}

describe("turn loop — slow organ", { tags: ["unit"] }, () => {
	it("dialog.send resolves when the tool completes before the deadline", async () => {
		const { faux, agent, dialog, timeoutMs } = makeAgent({ timeoutMs: 5_000 });

		const slowOrgan = defineOrgan(
			"slow",
			{
				"motor/slow.op": typedAction(
					{ name: "slow.op", description: "A slow op", inputSchema: z.object({}) },
					async () => {
						await new Promise<void>((r) => setTimeout(r, 500));
						return { result: "slow-done" };
					},
				),
			},
			{ description: "Slow organ for testing.", directives: ["Use slow.op when asked."] },
		);

		agent.load(slowOrgan);
		await agent.ready();

		faux.setResponses([fauxAssistantMessage([fauxToolCall("slow.op", {})]), fauxAssistantMessage("all done")]);

		const reply = await dialog.send("run the slow op", "human", timeoutMs);
		expect(reply).toBe("all done");
	}, 8_000);
});

describe("turn loop — hanging organ", { tags: ["unit"] }, () => {
	it("dialog.send rejects at its timeout when the tool never publishes a sense event", async () => {
		const { faux, agent, dialog } = makeAgent();
		const SEND_TIMEOUT_MS = 1_500;

		const hangOrgan = defineOrgan(
			"hang",
			{
				"motor/hang.op": typedAction(
					{ name: "hang.op", description: "A hanging op", inputSchema: z.object({}) },
					async () => {
						await new Promise<Record<string, unknown>>(() => {});
						return {};
					},
				),
			},
			{ description: "Hanging organ for testing.", directives: ["Use hang.op when asked."] },
		);

		agent.load(hangOrgan);
		await agent.ready();

		faux.setResponses([fauxAssistantMessage([fauxToolCall("hang.op", {})])]);

		const start = Date.now();
		await expect(dialog.send("run the hanging op", "human", SEND_TIMEOUT_MS)).rejects.toThrow(/timed out/i);

		const elapsed = Date.now() - start;
		expect(elapsed).toBeGreaterThan(SEND_TIMEOUT_MS - 200);
		expect(elapsed).toBeLessThan(SEND_TIMEOUT_MS + 1_000);
	}, 6_000);
});

describe("turn loop — error organ", { tags: ["unit"] }, () => {
	it("dialog.send resolves when the organ throws and the LLM handles the error", async () => {
		const { faux, agent, dialog, timeoutMs } = makeAgent({ timeoutMs: 5_000 });

		const errorOrgan = defineOrgan(
			"err",
			{
				"motor/err.op": typedAction(
					{ name: "err.op", description: "An op that fails", inputSchema: z.object({}) },
					async () => {
						throw new Error("organ exploded");
					},
				),
			},
			{ description: "Error organ for testing.", directives: ["Use err.op when asked."] },
		);

		agent.load(errorOrgan);
		await agent.ready();

		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("err.op", {})]),
			fauxAssistantMessage("I see the tool failed"),
		]);

		const reply = await dialog.send("run the failing op", "human", timeoutMs);
		expect(reply).toBe("I see the tool failed");
	}, 8_000);
});

describe("turn loop — schema validation failure", { tags: ["unit"] }, () => {
	it("turn completes when LLM sends wrong type for a schema field", async () => {
		const { faux, agent, dialog, timeoutMs } = makeAgent({ timeoutMs: 3_000 });

		const strictOrgan = defineOrgan(
			"strict",
			{
				"motor/strict.op": typedAction(
					{
						name: "strict.op",
						description: "Op requiring a numeric count.",
						inputSchema: z.object({ count: z.number() }),
					},
					async () => ({ result: "ok" }),
				),
			},
			{ description: "Strict schema organ.", directives: ["Use strict.op when asked."] },
		);

		agent.load(strictOrgan);
		await agent.ready();

		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("strict.op", { count: "3" })]),
			fauxAssistantMessage("I see the validation failed"),
		]);

		const reply = await dialog.send("call strict.op", "human", timeoutMs);
		expect(reply).toBe("I see the validation failed");
	}, 6_000);
});
