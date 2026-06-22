/**
 * Contract scan — runs schema and streaming contracts against all main organs.
 * Reports violations but does not fail — this is a detection tool, not a gate.
 * Run manually: npx vitest run test/contract-scan.test.ts
 */

import { createAgentOrgan } from "@dpopsuev/alef-adapter-agent";
import { createFsOrgan } from "@dpopsuev/alef-adapter-fs";
import { createShellOrgan } from "@dpopsuev/alef-adapter-shell";
import type { Organ } from "@dpopsuev/alef-kernel";
import type { Api, Model } from "@dpopsuev/alef-llm";
import { registerFauxProvider } from "@dpopsuev/alef-llm";
import { InProcessStrategy, type SubagentFactory } from "@dpopsuev/alef-runtime";
import { runSchemaContract, runStreamingContract } from "@dpopsuev/alef-testkit";
import { describe, expect, it } from "vitest";

const CWD = "/tmp";

function stubFactory(_model: Model<Api>): SubagentFactory {
	return () => ({
		async send(): Promise<string> {
			return "stub";
		},
		dispose() {},
	});
}

const faux = registerFauxProvider();
const delegateOrgan = createAgentOrgan({
	strategies: { explore: new InProcessStrategy([], stubFactory(faux.getModel())) },
});

const organs: Array<{ name: string; organ: Organ }> = [
	{ name: "organ-fs", organ: createFsOrgan({ cwd: CWD }) },
	{ name: "organ-shell", organ: createShellOrgan({ cwd: CWD }) },
	{ name: "organ-agent", organ: delegateOrgan },
];

describe("schema contract scan", { tags: ["unit"] }, () => {
	for (const { name, organ } of organs) {
		it(`${name} — all tools reject null required fields immediately`, async () => {
			const results = await runSchemaContract(organ, { timeoutMs: 400 });
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
	it("organ-shell/shell.exec — streaming organ emits chunks", async () => {
		const organ = createShellOrgan({ cwd: CWD });
		const result = await runStreamingContract(organ, "shell.exec", { command: "echo hello" }, { thresholdMs: 50 });
		if (result.violation) {
			console.warn(`[streaming violation] ${result.violation}`);
		}
		// shell.exec is typedStreamAction — should always stream
		expect(result.violation, "shell.exec must emit chunks (it uses typedStreamAction)").toBeUndefined();
	}, 10_000);

	it("organ-agent/agent.run — KNOWN GAP: typedAction blocks, never emits chunks", async () => {
		// This test documents the known streaming gap in organ-agent.
		// agent.run uses typedAction (one blocking result), not typedStreamAction.
		// Even if the inner agent takes 10s, no isFinal:false chunks reach the parent.
		// Fix: convert handleRun to typedStreamAction with AsyncQueue bridge.
		faux.setResponses([]); // inner LLM has no responses — returns error quickly

		const result = await runStreamingContract(
			delegateOrgan,
			"agent.run",
			{ text: "describe this project", profile: "explore", timeoutMs: 2_000 },
			{ thresholdMs: 0, timeoutMs: 5_000 }, // threshold=0 means: always check for chunks
		);

		console.info(`[agent.run] streamed=${result.streamed} durationMs=${result.durationMs}`);
		if (result.violation) console.warn(`[streaming gap DETECTED] ${result.violation}`);

		// Document the gap — agent.run never streams
		expect(result.streamed, "agent.run does not stream (known gap — needs typedStreamAction)").toBe(false);
	}, 10_000);

	it("organ-fs/fs.read — non-streaming tool, no streaming violation expected at short threshold", async () => {
		const organ = createFsOrgan({ cwd: CWD });
		// fs.read returns immediately — thresholdMs=3000 won't be triggered for a fast read
		const result = await runStreamingContract(
			organ,
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
