/**
 * Layer 3 — OTel pipeline proof.
 *
 * Verifies that:
 *   1. The harness registers a NodeTracerProvider that captures spans.
 *   2. alef.spine framework emits spans on Command events.
 *   3. Span attributes (alef.event.type, alef.cache.hit) are present.
 *
 * Uses a QuiescentLLMAdapter (no real API) so this runs in CI.
 */

import type { Adapter, Bus } from "@dpopsuev/alef-kernel";
import { describe, expect, it } from "vitest";
import { EvalHarness } from "../src/harness.js";

class FileReaderLLMAdapter implements Adapter {
	readonly name = "llm";
	readonly tools = [] as const;
	readonly subscriptions = { command: [] as const, event: ["llm.input"] as const };
	readonly sources = [] as const;
	mount(bus: Bus): () => void {
		return bus.event.subscribe("llm.input", async (event) => {
			const corr = event.correlationId;
			// Trigger one fs.read then reply.
			const done = new Promise<void>((resolve) => {
				const off = bus.event.subscribe("fs.read", (e) => {
					if (e.correlationId === corr) {
						off();
						resolve();
					}
				});
			});
			bus.command.publish({
				type: "fs.read",
				payload: { path: "test.txt", toolCallId: "tc-1" },
				correlationId: corr,
			});
			await done;
			bus.command.publish({
				type: "llm.response",
				payload: { text: "read done" },
				correlationId: corr,
			});
		});
	}
}

describe("OTel pipeline — span collection", { tags: ["integration"] }, () => {
	it("harness collects spans when an adapter handles a command event", async () => {
		const harness = new EvalHarness();
		const metrics = await harness.run(
			async (ctx) => {
				await ctx.writeFile("test.txt", "hello");
				await ctx.send({ text: "read it" });
			},
			{ scenario: "otel-smoke", extraAdapters: [new FileReaderLLMAdapter()] },
		);
		// FsAdapter dispatches through framework → alef.command/fs.read span emitted
		expect(metrics.totalSpans).toBeGreaterThan(0);
	});

	it("spans have alef.event.type attribute", async () => {
		const harness = new EvalHarness();
		const metrics = await harness.run(
			async (ctx) => {
				await ctx.writeFile("test.txt", "hello");
				await ctx.send({ text: "read it" });
			},
			{ scenario: "otel-attrs", extraAdapters: [new FileReaderLLMAdapter()] },
		);
		const withAttr = metrics.spans.filter((s) => s.attributes["alef.event.type"] !== undefined);
		expect(withAttr.length).toBeGreaterThan(0);
	});

	it("fs.read span has alef.cache.hit=false on first call", async () => {
		const harness = new EvalHarness();
		const metrics = await harness.run(
			async (ctx) => {
				await ctx.writeFile("test.txt", "hello");
				await ctx.send({ text: "read it" });
			},
			{ scenario: "otel-cache-attr", extraAdapters: [new FileReaderLLMAdapter()] },
		);

		const fsReadSpans = metrics.spans.filter((s) => s.name.includes("alef.command/fs.read"));
		expect(fsReadSpans.length).toBeGreaterThanOrEqual(1);
		expect(fsReadSpans[0].attributes["alef.cache.hit"]).toBe(false);
	});
});
