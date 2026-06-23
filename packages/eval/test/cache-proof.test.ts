/**
 * CacheProof.
 *
 * A ScriptedLLMAdapter reads the same file twice in one turn.
 * The second read must be served from cache (alef.cache.hit=true on span).
 * Proves: OTel spans carry cache attributes, OAE metric is non-zero.
 */

import type { Adapter, Bus, EventMessage } from "@dpopsuev/alef-kernel";
import { describe, expect, it } from "vitest";
import { EvalHarness } from "../src/harness.js";

// ---------------------------------------------------------------------------
// ScriptedLLMAdapter — reads one file twice, then replies.
// ---------------------------------------------------------------------------

class ScriptedReadTwiceLLM implements Adapter {
	readonly name = "llm";
	readonly tools = [] as const;
	readonly reads: Array<{ cacheHit: boolean }> = [];
	readonly subscriptions = { command: [] as const, event: ["llm.input"] as const };
	readonly sources = [] as const;

	mount(bus: Bus): () => void {
		return bus.event.subscribe("llm.input", async (event) => {
			const corr = event.correlationId;

			// Helper: publish Command/fs.read and await Event/fs.read.
			const readFile = (path: string, toolCallId: string): Promise<EventMessage> =>
				new Promise((resolve) => {
					const off = bus.event.subscribe("fs.read", (e) => {
						if (e.payload.toolCallId === toolCallId && e.correlationId === corr) {
							off();
							resolve(e);
						}
					});
					bus.command.publish({
						type: "fs.read",
						payload: { path, toolCallId },
						correlationId: corr,
					});
				});

			// First read — cache miss.
			await readFile("target.txt", "tc-1");
			// Second read of same file — cache hit.
			await readFile("target.txt", "tc-2");

			bus.command.publish({
				type: "llm.response",
				payload: { text: "read twice" },
				correlationId: corr,
			});
		});
	}
}

// ---------------------------------------------------------------------------

describe("EvalHarness — file read cache hit", { tags: ["integration"] }, () => {
	it("second fs.read of same file is served from cache (alef.cache.hit=true)", async () => {
		const harness = new EvalHarness();

		const metrics = await harness.run(
			async (ctx) => {
				await ctx.writeFile("target.txt", "hello cache");
				const reply = await ctx.send({ text: "read it twice" });
				if (reply !== "read twice") throw new Error(`unexpected reply: ${reply}`);
			},
			{
				scenario: "cache-proof",
				extraAdapters: [new ScriptedReadTwiceLLM()],
			},
		);

		expect(metrics.passed).toBe(true);

		// At least one fs.read span should have alef.cache.hit=true.
		const hitSpans = metrics.spans.filter(
			(s) => s.name.includes("fs.read") && s.attributes["alef.cache.hit"] === true,
		);
		expect(hitSpans.length).toBeGreaterThanOrEqual(1);

		// OAE should be > 0 (some cache hits).
		expect(metrics.oae).toBeGreaterThan(0);

		// Cache hits + misses for fs.read: expect exactly 1 miss and 1 hit.
		const fsReadSpans = metrics.spans.filter((s) => s.name.includes("alef.command/fs.read"));
		const misses = fsReadSpans.filter((s) => s.attributes["alef.cache.hit"] === false);
		const hits = fsReadSpans.filter((s) => s.attributes["alef.cache.hit"] === true);

		expect(misses.length).toBe(1); // First read: handler called.
		expect(hits.length).toBe(1); // Second read: cache.
	});
});
