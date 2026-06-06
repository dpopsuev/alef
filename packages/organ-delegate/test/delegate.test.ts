import type { ExecutionStrategy } from "@dpopsuev/alef-kernel";
import { NerveFixture, organComplianceSuite } from "@dpopsuev/alef-testkit/organ";
import { describe, expect, it } from "vitest";
import { createDelegateOrgan } from "../src/organ.js";

// Stub strategy — stays within organ-delegate's own dep graph.
// Calls onChunk so the AsyncQueue relays isFinal:false sense events,
// satisfying the streaming contract without importing runner internals.
const slowStrategy: ExecutionStrategy = {
	async send(_text, _sender, _timeoutMs, onChunk) {
		await new Promise((r) => setTimeout(r, 80));
		onChunk?.("packages: ");
		await new Promise((r) => setTimeout(r, 40));
		onChunk?.("spine, corpus, runner");
		return "packages: spine, corpus, runner";
	},
};

organComplianceSuite(() => createDelegateOrgan({ strategies: { explore: slowStrategy } }), {
	streaming: {
		"agent.run": {
			validPayload: { text: "list the packages", profile: "explore" },
			thresholdMs: 100,
		},
	},
});

// ---------------------------------------------------------------------------
// Parallel stream isolation — organ-level concern, no LLM dispatch needed.
//
// Two concurrent motor/agent.run publishes must produce fully isolated sense
// streams: chunks emitted by strategy A must not appear in correlation B and
// vice-versa. This is a property of organ-delegate's AsyncQueue and the spine
// toolCallId/correlationId routing — testable without Cerebrum.
// ---------------------------------------------------------------------------

describe("agent.run — parallel stream isolation", { tags: ["unit"] }, () => {
	it("two concurrent calls emit chunks only to their own sense correlation", async () => {
		// Given: a strategy that encodes the task text in every chunk it emits.
		const strategy: ExecutionStrategy = {
			async send(text, _sender, _timeoutMs, onChunk) {
				onChunk?.(`chunk-for:${text}`);
				return `done:${text}`;
			},
		};

		const f = new NerveFixture();
		f.mount(createDelegateOrgan({ strategies: { explore: strategy } }));

		const sense = f.nerve.asNerve().sense;
		const chunksPerCorr = new Map<string, string[]>([
			["corr-A", []],
			["corr-B", []],
		]);
		const finals = new Set<string>();

		// When: two motor events are published simultaneously with distinct correlationIds.
		const done = new Promise<void>((resolve) => {
			sense.subscribe("agent.run", (e) => {
				const chunks = chunksPerCorr.get(e.correlationId);
				if (!chunks) return;
				const p = e.payload as { isFinal?: boolean; text?: string };
				if (p.isFinal === false && p.text) chunks.push(p.text);
				if (p.isFinal === true || e.isError) {
					finals.add(e.correlationId);
					if (finals.size === 2) resolve();
				}
			});
		});

		const motor = f.nerve.asNerve().motor;
		motor.publish({
			type: "agent.run",
			payload: { text: "task-A", profile: "explore", toolCallId: "tc-A" },
			correlationId: "corr-A",
		});
		motor.publish({
			type: "agent.run",
			payload: { text: "task-B", profile: "explore", toolCallId: "tc-B" },
			correlationId: "corr-B",
		});

		await done;
		f.dispose();

		// Then: each correlation only received chunks from its own inner strategy call.
		const chunksA = chunksPerCorr.get("corr-A")!;
		const chunksB = chunksPerCorr.get("corr-B")!;

		expect(
			chunksA.some((c) => c.includes("task-A")),
			"corr-A must receive task-A chunks",
		).toBe(true);
		expect(
			chunksB.some((c) => c.includes("task-B")),
			"corr-B must receive task-B chunks",
		).toBe(true);
		expect(
			chunksA.some((c) => c.includes("task-B")),
			"task-B must not leak into corr-A",
		).toBe(false);
		expect(
			chunksB.some((c) => c.includes("task-A")),
			"task-A must not leak into corr-B",
		).toBe(false);
	}, 5_000);

	it("three concurrent calls all complete with no cross-contamination", async () => {
		const strategy: ExecutionStrategy = {
			async send(text, _sender, _timeoutMs, onChunk) {
				onChunk?.(`ident:${text}`);
				return `done:${text}`;
			},
		};

		const f = new NerveFixture();
		f.mount(createDelegateOrgan({ strategies: { explore: strategy } }));

		const sense = f.nerve.asNerve().sense;
		const corrs = ["corr-X", "corr-Y", "corr-Z"];
		const chunksPerCorr = new Map(corrs.map((c) => [c, [] as string[]]));
		const finals = new Set<string>();

		const done = new Promise<void>((resolve) => {
			sense.subscribe("agent.run", (e) => {
				const chunks = chunksPerCorr.get(e.correlationId);
				if (!chunks) return;
				const p = e.payload as { isFinal?: boolean; text?: string };
				if (p.isFinal === false && p.text) chunks.push(p.text);
				if (p.isFinal === true || e.isError) {
					finals.add(e.correlationId);
					if (finals.size === 3) resolve();
				}
			});
		});

		const motor = f.nerve.asNerve().motor;
		motor.publish({
			type: "agent.run",
			payload: { text: "agent-X", profile: "explore", toolCallId: "tc-X" },
			correlationId: "corr-X",
		});
		motor.publish({
			type: "agent.run",
			payload: { text: "agent-Y", profile: "explore", toolCallId: "tc-Y" },
			correlationId: "corr-Y",
		});
		motor.publish({
			type: "agent.run",
			payload: { text: "agent-Z", profile: "explore", toolCallId: "tc-Z" },
			correlationId: "corr-Z",
		});

		await done;
		f.dispose();

		for (const [corr, chunks] of chunksPerCorr) {
			const ownAgent = corr.replace("corr-", "agent-");
			const otherAgents = ["agent-X", "agent-Y", "agent-Z"].filter((a) => a !== ownAgent);
			expect(
				chunks.some((c) => c.includes(ownAgent)),
				`${corr} must receive its own chunks`,
			).toBe(true);
			for (const other of otherAgents) {
				expect(
					chunks.some((c) => c.includes(other)),
					`${other} must not leak into ${corr}`,
				).toBe(false);
			}
		}
	}, 5_000);
});
