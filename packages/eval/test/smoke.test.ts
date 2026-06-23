/**
 * Smoke test.
 *
 * Proves the harness boots, runs a scenario with a scripted LLM (no real API),
 * collects metrics, and disposes cleanly.
 */

import type { Adapter, Bus } from "@dpopsuev/alef-kernel";
import { describe, expect, it } from "vitest";
import { EvalHarness } from "../src/harness.js";
import { formatReport } from "../src/report.js";

// ---------------------------------------------------------------------------
// QuiescentLLMAdapter — canned reply, no tool calls. No API key needed.
// ---------------------------------------------------------------------------

class QuiescentLLMAdapter implements Adapter {
	readonly name = "llm";
	readonly tools = [] as const;
	readonly subscriptions = { command: [] as const, event: ["llm.input"] as const };
	readonly sources = [] as const;

	constructor(private readonly reply: string = "smoke ok") {}

	mount(bus: Bus): () => void {
		return bus.event.subscribe("llm.input", (event) => {
			bus.command.publish({
				type: "llm.response",
				payload: { text: this.reply },
				correlationId: event.correlationId,
			});
		});
	}
}

// ---------------------------------------------------------------------------

describe("EvalHarness — smoke", { tags: ["integration"] }, () => {
	it("harness boots, runs scenario, and returns passing metrics", async () => {
		const harness = new EvalHarness();

		const metrics = await harness.run(
			async (ctx) => {
				const reply = await ctx.send({ text: "hello" });
				if (reply !== "smoke ok") throw new Error(`unexpected reply: ${reply}`);
			},
			{
				scenario: "smoke",
				extraAdapters: [new QuiescentLLMAdapter("smoke ok")],
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
				extraAdapters: [new QuiescentLLMAdapter()],
			},
		);

		expect(metrics.passed).toBe(false);
		expect(metrics.error).toMatch(/intentional failure/);
	});

	it("formatReport returns a non-empty string", async () => {
		const harness = new EvalHarness();
		const metrics = await harness.run(async () => {}, {
			scenario: "smoke-format",
			extraAdapters: [new QuiescentLLMAdapter()],
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
				extraAdapters: [new QuiescentLLMAdapter()],
			},
		);

		// Workspace removed after run.
		expect(existsSync(capturedWorkspace)).toBe(false);
	});
});
