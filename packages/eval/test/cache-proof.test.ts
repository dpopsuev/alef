/**
 * TSK-118 — CacheProof.
 *
 * A ScriptedLLMOrgan reads the same file twice in one turn.
 * The second read must be served from cache (alef.cache.hit=true on span).
 * Proves: OTel spans carry cache attributes, OAE metric is non-zero.
 */

import type { Nerve, Organ, SenseEvent } from "@dpopsuev/alef-spine";
import { describe, expect, it } from "vitest";
import { EvalHarness } from "../src/harness.js";

// ---------------------------------------------------------------------------
// ScriptedLLMOrgan — reads one file twice, then replies.
// ---------------------------------------------------------------------------

class ScriptedReadTwiceLLM implements Organ {
	readonly name = "llm";
	readonly tools = [] as const;
	readonly reads: Array<{ cacheHit: boolean }> = [];
	readonly subscriptions = { motor: [] as const, sense: ["dialog.message"] as const };

	mount(nerve: Nerve): () => void {
		return nerve.sense.subscribe("dialog.message", async (event) => {
			const corr = event.correlationId;

			// Helper: publish Motor/fs.read and await Sense/fs.read.
			const readFile = (path: string, toolCallId: string): Promise<SenseEvent> =>
				new Promise((resolve) => {
					const off = nerve.sense.subscribe("fs.read", (e) => {
						if (e.payload.toolCallId === toolCallId && e.correlationId === corr) {
							off();
							resolve(e);
						}
					});
					nerve.motor.publish({
						type: "fs.read",
						payload: { path, toolCallId },
						correlationId: corr,
						timestamp: Date.now(),
					});
				});

			// First read — cache miss.
			await readFile("target.txt", "tc-1");
			// Second read of same file — cache hit.
			await readFile("target.txt", "tc-2");

			nerve.motor.publish({
				type: "dialog.message",
				payload: { text: "read twice" },
				correlationId: corr,
				timestamp: Date.now(),
			});
		});
	}
}

// ---------------------------------------------------------------------------

describe("EvalHarness — CacheProof (TSK-118)", () => {
	it("second fs.read of same file is served from cache (alef.cache.hit=true)", async () => {
		const harness = new EvalHarness();

		const metrics = await harness.run(
			async (ctx) => {
				await ctx.writeFile("target.txt", "hello cache");
				const reply = await ctx.send("read it twice");
				if (reply !== "read twice") throw new Error(`unexpected reply: ${reply}`);
			},
			{
				scenario: "cache-proof",
				extraOrgans: [new ScriptedReadTwiceLLM()],
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
		const fsReadSpans = metrics.spans.filter((s) => s.name.includes("alef.motor/fs.read"));
		const misses = fsReadSpans.filter((s) => s.attributes["alef.cache.hit"] === false);
		const hits = fsReadSpans.filter((s) => s.attributes["alef.cache.hit"] === true);

		expect(misses.length).toBe(1); // First read: handler called.
		expect(hits.length).toBe(1); // Second read: cache.
	});
});
