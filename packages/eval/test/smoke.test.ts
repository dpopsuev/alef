/**
 * TSK-119 — Smoke test.
 *
 * Proves the harness boots, runs a scenario with a scripted LLM (no real API),
 * collects metrics, and disposes cleanly.
 */

import type { Nerve, Organ } from "@dpopsuev/alef-spine";
import { describe, expect, it } from "vitest";
import { EvalHarness, formatReport } from "../src/harness.js";

// ---------------------------------------------------------------------------
// QuiescentLLMOrgan — canned reply, no tool calls. No API key needed.
// ---------------------------------------------------------------------------

class QuiescentLLMOrgan implements Organ {
	readonly name = "llm";
	readonly tools = [] as const;
	readonly subscriptions = { motor: [] as const, sense: ["dialog.message"] as const };

	constructor(private readonly reply: string = "smoke ok") {}

	mount(nerve: Nerve): () => void {
		return nerve.sense.subscribe("dialog.message", (event) => {
			nerve.motor.publish({
				type: "dialog.message",
				payload: { text: this.reply },
				correlationId: event.correlationId,
				timestamp: Date.now(),
			});
		});
	}
}

// ---------------------------------------------------------------------------

describe("EvalHarness — smoke (TSK-119)", () => {
	it("harness boots, runs scenario, and returns passing metrics", async () => {
		const harness = new EvalHarness();

		const metrics = await harness.run(
			async (ctx) => {
				const reply = await ctx.send("hello");
				if (reply !== "smoke ok") throw new Error(`unexpected reply: ${reply}`);
			},
			{
				scenario: "smoke",
				extraOrgans: [new QuiescentLLMOrgan("smoke ok")],
			},
		);

		expect(metrics.scenario).toBe("smoke");
		expect(metrics.passed).toBe(true);
		expect(metrics.error).toBeUndefined();
		expect(metrics.loopDetected).toBe(false);
		expect(metrics.totalEvents).toBeGreaterThan(0);
		expect(metrics.durationMs).toBeGreaterThan(0);
	});

	it("harness captures a scenario failure as passed=false with error message", async () => {
		const harness = new EvalHarness();

		const metrics = await harness.run(
			async (_ctx) => {
				throw new Error("intentional failure");
			},
			{
				scenario: "smoke-fail",
				extraOrgans: [new QuiescentLLMOrgan()],
			},
		);

		expect(metrics.passed).toBe(false);
		expect(metrics.error).toMatch(/intentional failure/);
	});

	it("formatReport returns a non-empty string", async () => {
		const harness = new EvalHarness();
		const metrics = await harness.run(async () => {}, {
			scenario: "smoke-format",
			extraOrgans: [new QuiescentLLMOrgan()],
		});

		const report = formatReport(metrics);
		expect(report).toContain("smoke-format");
		expect(report).toMatch(/PASS|FAIL/);
	});

	it("harness cleans up workspace after run", async () => {
		const { existsSync } = await import("node:fs");
		let capturedWorkspace = "";
		const harness = new EvalHarness();

		await harness.run(
			async (ctx) => {
				capturedWorkspace = ctx.workspace;
				// Workspace exists during run.
				expect(existsSync(capturedWorkspace)).toBe(true);
			},
			{
				scenario: "smoke-cleanup",
				extraOrgans: [new QuiescentLLMOrgan()],
			},
		);

		// Workspace removed after run.
		expect(existsSync(capturedWorkspace)).toBe(false);
	});
});
