/**
 * TSK-120 — Loop detection.
 *
 * A LoopingLLMOrgan calls the same Motor event type repeatedly.
 * EvaluatorOrgan must detect the loop and set loopDetected=true.
 */

import type { Nerve, Organ } from "@dpopsuev/alef-spine";
import { describe, expect, it } from "vitest";
import { EvalHarness } from "../src/harness.js";

// ---------------------------------------------------------------------------
// LoopingLLMOrgan — calls fs.read N times in a row on the same correlationId.
// ---------------------------------------------------------------------------

class LoopingLLMOrgan implements Organ {
	readonly name = "llm";
	readonly tools = [] as const;
	readonly subscriptions = { motor: [] as const, sense: ["dialog.message"] as const };

	constructor(private readonly loopCount: number) {}

	mount(nerve: Nerve): () => void {
		return nerve.sense.subscribe("dialog.message", async (event) => {
			// Call fs.read loopCount times — triggers loop detector.
			for (let i = 0; i < this.loopCount; i++) {
				nerve.motor.publish({
					type: "fs.read",
					payload: { path: "nonexistent.txt", toolCallId: `tc-${i}` },
					correlationId: event.correlationId,
					timestamp: Date.now(),
				});
				// Small delay so sense events propagate.
				await new Promise((r) => setTimeout(r, 2));
			}
			// Then send a reply so dialog.send() resolves.
			nerve.motor.publish({
				type: "dialog.message",
				payload: { text: "done looping" },
				correlationId: event.correlationId,
				timestamp: Date.now(),
			});
		});
	}
}

// ---------------------------------------------------------------------------

describe("EvalHarness — loop detection (TSK-120)", () => {
	it("detects loop when same Motor event type exceeds threshold", async () => {
		const harness = new EvalHarness();

		const metrics = await harness.run(
			async (ctx) => {
				await ctx.send("start");
			},
			{
				scenario: "loop-detection",
				extraOrgans: [new LoopingLLMOrgan(15)],
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
				await ctx.send("start");
			},
			{
				scenario: "no-loop",
				extraOrgans: [new LoopingLLMOrgan(3)],
				loopThreshold: 10,
			},
		);

		expect(metrics.loopDetected).toBe(false);
		expect(metrics.passed).toBe(true);
	});
});
