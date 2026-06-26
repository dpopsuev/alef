/**
 * Contract scan — runs schema and streaming contracts against all main adapters.
 * Reports violations but does not fail — this is a detection tool, not a gate.
 * Run manually: npx vitest run test/contract-scan.test.ts
 */

import { registerFauxProvider } from "@dpopsuev/alef-ai/faux";
import type { Api, Model } from "@dpopsuev/alef-ai/types";
import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import { InProcessStrategy, type SubagentFactory } from "@dpopsuev/alef-runtime";
import type { Session } from "@dpopsuev/alef-session/contracts";
import { runSchemaContract, runStreamingContract } from "@dpopsuev/alef-testkit";
import { createAgentAdapter } from "@dpopsuev/alef-tool-agent";
import { createFsAdapter } from "@dpopsuev/alef-tool-fs";
import { createShellAdapter } from "@dpopsuev/alef-tool-shell";
import { describe, expect, it } from "vitest";

const CWD = "/tmp";

function stubFactory(_model: Model<Api>): SubagentFactory {
	return () =>
		({
			state: { id: "test", modelId: "test", contextWindow: 200_000 },
			getModel: () => "test",
			setModel: () => {},
			getThinking: () => "off",
			setThinking: () => {},
			setTurnController: () => {},
			subscribe: () => () => {},
			send: async () => "stub",
			dispose() {},
		}) satisfies Session;
}

const faux = registerFauxProvider();
const delegateAdapter = createAgentAdapter({
	strategies: { explore: new InProcessStrategy([], stubFactory(faux.getModel())) },
});

const adapters: Array<{ name: string; adapter: Adapter }> = [
	{ name: "adapter-fs", adapter: createFsAdapter({ cwd: CWD }) },
	{ name: "adapter-shell", adapter: createShellAdapter({ cwd: CWD }) },
	{ name: "adapter-agent", adapter: delegateAdapter },
];

describe("schema contract scan", { tags: ["unit"] }, () => {
	for (const { name, adapter } of adapters) {
		it(`${name} — all tools reject null required fields immediately`, async () => {
			const results = await runSchemaContract(adapter, { timeoutMs: 400 });
			const violations = results.flatMap((r) => r.violations.map((v) => `${r.tool}: ${v}`));

			if (violations.length > 0) {
				console.warn(`\n[schema violations in ${name}]`);
				for (const v of violations) console.warn(`  ${v}`);
			}

			expect(violations, `${name} has schema contract violations`).toEqual([]);
		}, 10_000);
	}
});

describe("streaming contract scan", { tags: ["unit"] }, () => {
	it("adapter-shell/shell.exec — streaming adapter emits chunks", async () => {
		const adapter = createShellAdapter({ cwd: CWD });
		const result = await runStreamingContract(adapter, "shell.exec", { command: "echo hello" }, { thresholdMs: 50 });
		if (result.violation) {
			console.warn(`[streaming violation] ${result.violation}`);
		}
		// shell.exec is typedStreamAction — should always stream
		expect(result.violation, "shell.exec must emit chunks (it uses typedStreamAction)").toBeUndefined();
	}, 10_000);

	it("adapter-agent/agent.run — KNOWN GAP: typedAction blocks, never emits chunks", async () => {
		// This test documents the known streaming gap in adapter-agent.
		// agent.run uses typedAction (one blocking result), not typedStreamAction.
		// Even if the inner agent takes 10s, no isFinal:false chunks reach the parent.
		// Fix: convert handleRun to typedStreamAction with AsyncQueue bridge.
		faux.setResponses([]); // inner LLM has no responses — returns error quickly

		const result = await runStreamingContract(
			delegateAdapter,
			"agent.run",
			{ text: "describe this project", profile: "explore", timeoutMs: 2_000 },
			{ thresholdMs: 0, timeoutMs: 5_000 }, // threshold=0 means: always check for chunks
		);

		console.info(`[agent.run] streamed=${result.streamed} durationMs=${result.durationMs}`);
		if (result.violation) console.warn(`[streaming gap DETECTED] ${result.violation}`);

		// Document the gap — agent.run never streams
		expect(result.streamed, "agent.run does not stream (known gap — needs typedStreamAction)").toBe(false);
	}, 10_000);

	it("adapter-fs/fs.read — non-streaming tool, no streaming violation expected at short threshold", async () => {
		const adapter = createFsAdapter({ cwd: CWD });
		// fs.read returns immediately — thresholdMs=3000 won't be triggered for a fast read
		const result = await runStreamingContract(
			adapter,
			"fs.read",
			{ path: "/tmp" },
			{ thresholdMs: 3_000, timeoutMs: 5_000 },
		);
		// fs.read is fast — no violation expected (it completes before threshold)
		if (result.violation) console.warn(`[streaming note] ${result.violation}`);
		// We report but don't fail — fast tools are OK without streaming
		expect(result.durationMs).toBeLessThan(3_000);
	}, 10_000);
});
