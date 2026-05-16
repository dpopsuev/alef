/**
 * Layer 3 — OTel pipeline proof.
 *
 * Verifies that:
 *   1. The harness registers a NodeTracerProvider that captures spans.
 *   2. alef.spine framework emits spans on Motor events.
 *   3. Span attributes (alef.event.type, alef.cache.hit) are present.
 *
 * Uses a QuiescentLLMOrgan (no real API) so this runs in CI.
 */

import type { Nerve, Organ } from "@dpopsuev/alef-spine";
import { describe, expect, it } from "vitest";
import { EvalHarness } from "../src/harness.js";

class FileReaderLLMOrgan implements Organ {
	readonly name = "llm";
	readonly tools = [] as const;
	readonly subscriptions = { motor: [] as const, sense: ["dialog.message"] as const };
	mount(nerve: Nerve): () => void {
		return nerve.sense.subscribe("dialog.message", async (event) => {
			const corr = event.correlationId;
			// Trigger one fs.read then reply.
			const done = new Promise<void>((resolve) => {
				const off = nerve.sense.subscribe("fs.read", (e) => {
					if (e.correlationId === corr) {
						off();
						resolve();
					}
				});
			});
			nerve.motor.publish({
				type: "fs.read",
				payload: { path: "test.txt", toolCallId: "tc-1" },
				correlationId: corr,
				timestamp: Date.now(),
			});
			await done;
			nerve.motor.publish({
				type: "dialog.message",
				payload: { text: "read done" },
				correlationId: corr,
				timestamp: Date.now(),
			});
		});
	}
}

describe("OTel pipeline — span collection", () => {
	it("harness collects spans when a corpus organ handles a Motor event", async () => {
		const harness = new EvalHarness();
		const metrics = await harness.run(
			async (ctx) => {
				await ctx.writeFile("test.txt", "hello");
				await ctx.send("read it");
			},
			{ scenario: "otel-smoke", extraOrgans: [new FileReaderLLMOrgan()] },
		);
		// FsOrgan dispatches through framework → alef.motor/fs.read span emitted
		expect(metrics.totalSpans).toBeGreaterThan(0);
	});

	it("spans have alef.event.type attribute", async () => {
		const harness = new EvalHarness();
		const metrics = await harness.run(
			async (ctx) => {
				await ctx.writeFile("test.txt", "hello");
				await ctx.send("read it");
			},
			{ scenario: "otel-attrs", extraOrgans: [new FileReaderLLMOrgan()] },
		);
		const withAttr = metrics.spans.filter((s) => s.attributes["alef.event.type"] !== undefined);
		expect(withAttr.length).toBeGreaterThan(0);
	});

	it("fs.read span has alef.cache.hit=false on first call", async () => {
		const harness = new EvalHarness();
		const metrics = await harness.run(
			async (ctx) => {
				await ctx.writeFile("test.txt", "hello");
				await ctx.send("read it");
			},
			{ scenario: "otel-cache-attr", extraOrgans: [new FileReaderLLMOrgan()] },
		);

		const fsReadSpans = metrics.spans.filter((s) => s.name.includes("alef.motor/fs.read"));
		expect(fsReadSpans.length).toBeGreaterThanOrEqual(1);
		expect(fsReadSpans[0].attributes["alef.cache.hit"]).toBe(false);
	});
});
