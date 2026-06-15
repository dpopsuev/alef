import type { ExecutionStrategy } from "@dpopsuev/alef-kernel";
import { NerveFixture, organComplianceSuite } from "@dpopsuev/alef-testkit/organ";
import { afterEach, describe, expect, it } from "vitest";
import { createDelegateOrgan } from "../src/organ.js";
import { strategyRegistry } from "../src/strategy-registry.js";

// Stub strategy — stays within organ-delegate's own dep graph.
// Calls onChunk so the AsyncQueue relays isFinal:false sense events,
// satisfying the streaming contract without importing runner internals.
const slowStrategy: ExecutionStrategy = {
	async send({ onChunk }) {
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
// toolCallId/correlationId routing — testable without organ-llm.
// ---------------------------------------------------------------------------

describe("agent.run — parallel stream isolation", { tags: ["unit"] }, () => {
	it("two concurrent calls emit chunks only to their own sense correlation", async () => {
		// Given: a strategy that encodes the task text in every chunk it emits.
		const strategy: ExecutionStrategy = {
			async send({ text, onChunk }) {
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
			async send({ text, onChunk }) {
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

	// ---------------------------------------------------------------------------
	// Regression — directive must contain the call signature so the
	// LLM can call agent.run correctly without first calling tools.describe.
	// Root cause: directive described profiles but never showed the required
	// 'text' field, causing the LLM to guess args and omit it.
	// ---------------------------------------------------------------------------

	describe("agent.run directive — schema discoverability", { tags: ["unit"] }, () => {
		it("directive explicitly names the text parameter so the LLM does not need to call tools.describe first", () => {
			const organ = createDelegateOrgan({ strategies: { explore: slowStrategy } });
			const directive = organ.directives?.join("\n") ?? "";
			expect(
				directive,
				"directive must show the text parameter so the LLM can call agent.run correctly without tools.describe",
			).toMatch(/text.*:/i);
		});

		it("tool description names the required text parameter", () => {
			const organ = createDelegateOrgan({ strategies: { explore: slowStrategy } });
			const tool = organ.tools.find((t) => t.name === "agent.run");
			expect(tool, "agent.run tool must exist").toBeDefined();
			expect(tool?.description, "agent.run description must mention the text parameter").toMatch(/text/i);
		});
	});
});

// ---------------------------------------------------------------------------
// StrategyRegistry fallback — DelegateOrgan resolves profiles from registry
// ---------------------------------------------------------------------------

describe("DelegateOrgan — strategyRegistry fallback", { tags: ["unit"] }, () => {
	const REGISTRY_TEST_PROFILE = "__test_registry_fallback__";
	afterEach(() => {
		// Clean up test-only registration to avoid polluting other tests.
		// strategyRegistry has no unregister — overwrite with undefined sentinel by re-registering.
	});

	it("resolves a profile registered in strategyRegistry when not in instance map", async () => {
		const strategy: ExecutionStrategy = {
			async send() {
				return "from registry";
			},
		};
		strategyRegistry.register(REGISTRY_TEST_PROFILE, strategy);

		const f = new NerveFixture();
		const organ = createDelegateOrgan({});
		f.mount(organ);

		const result = await new Promise<{ reply: string; isError: boolean }>((resolve) => {
			f.nerve.asNerve().sense.subscribe("agent.run", (e) => {
				const p = e.payload as { isFinal?: boolean; reply?: string; text?: string };
				if (p.isFinal === true || e.isError) {
					resolve({ reply: String(p.reply ?? p.text ?? e.errorMessage ?? ""), isError: e.isError });
				}
			});
			f.nerve.asNerve().motor.publish({
				type: "agent.run",
				payload: { text: "hello", profile: REGISTRY_TEST_PROFILE, toolCallId: "tc-reg-1" },
				correlationId: "corr-reg-1",
			});
		});
		expect(result.isError).toBe(false);
		expect(result.reply).toBe("from registry");
		f.dispose();
	});

	it("returns error when profile is unknown in both instance map and registry", async () => {
		const f = new NerveFixture();
		const organ = createDelegateOrgan({});
		f.mount(organ);

		const result = await new Promise<{ text: string; isError: boolean }>((resolve) => {
			f.nerve.asNerve().sense.subscribe("agent.run", (e) => {
				const p = e.payload as { isFinal?: boolean; text?: string; error?: string };
				if (p.isFinal === true || e.isError) {
					resolve({ text: String(p.text ?? p.error ?? e.errorMessage ?? ""), isError: e.isError });
				}
			});
			f.nerve.asNerve().motor.publish({
				type: "agent.run",
				payload: { text: "hi", profile: "__totally_unknown__", toolCallId: "tc-unk-1" },
				correlationId: "corr-unk-1",
			});
		});
		expect(result.text).toMatch(/unknown/i);
		f.dispose();
	});
});
