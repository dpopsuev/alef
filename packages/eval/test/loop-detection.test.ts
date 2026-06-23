/**
 * Loop detection.
 *
 * A LoopingLLMAdapter calls the same Command event type repeatedly.
 * EvaluatorAdapter must detect the loop and set loopDetected=true.
 */

import type { Adapter, Bus } from "@dpopsuev/alef-kernel";
import { describe, expect, it } from "vitest";
import { EvalHarness } from "../src/harness.js";

// ---------------------------------------------------------------------------
// LoopingLLMAdapter — calls fs.read N times in a row on the same correlationId.
// ---------------------------------------------------------------------------

class LoopingLLMAdapter implements Adapter {
	readonly name = "llm";
	readonly tools = [] as const;
	readonly subscriptions = { command: [] as const, event: ["llm.input"] as const, notification: [] as const };
	readonly sources = [] as const;

	constructor(private readonly loopCount: number) {}

	mount(bus: Bus): () => void {
		return bus.event.subscribe("llm.input", async (event) => {
			// Call fs.read loopCount times — triggers loop detector.
			for (let i = 0; i < this.loopCount; i++) {
				bus.command.publish({
					type: "fs.read",
					payload: { path: "nonexistent.txt", toolCallId: `tc-${i}` },
					correlationId: event.correlationId,
				});
				// Small delay so event messages propagate.
				await new Promise((r) => setTimeout(r, 2));
			}
			// Then send a reply so dialog.send() resolves.
			bus.command.publish({
				type: "llm.response",
				payload: { text: "done looping" },
				correlationId: event.correlationId,
			});
		});
	}
}

// ---------------------------------------------------------------------------

describe("EvalHarness — loop detection", { tags: ["integration"] }, () => {
	it("detects loop when same Command event type exceeds threshold", async () => {
		const harness = new EvalHarness();

		const metrics = await harness.run(
			async (ctx) => {
				await ctx.send({ text: "start" });
			},
			{
				scenario: "loop-detection",
				extraAdapters: [new LoopingLLMAdapter(15)],
				loopThreshold: 10,
			},
		);

		expect(metrics.loopDetected).toBe(true);
		expect(metrics.loopEventType).toBe("fs.read");
		// Loop detection makes the run fail.
		expect(metrics.passed).toBe(false);
		expect(metrics.error).toMatch(/loop detected/i);
	});

	it("does not flag a loop below the threshold", async () => {
		const harness = new EvalHarness();

		const metrics = await harness.run(
			async (ctx) => {
				await ctx.send({ text: "start" });
			},
			{
				scenario: "no-loop",
				extraAdapters: [new LoopingLLMAdapter(3)],
				loopThreshold: 10,
			},
		);

		expect(metrics.loopDetected).toBe(false);
		expect(metrics.passed).toBe(true);
	});
});
