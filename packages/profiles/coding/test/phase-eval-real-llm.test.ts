/**
 * PhaseEvaluation real-LLM test — fixBugWithCleanCommit
 *
 * Boots a full coding agent against the real Vertex Anthropic backend.
 * Runs the five-phase evaluation:
 *   1. diagnose  — identify the off-by-one root cause
 *   2. fix       — edit sum.ts, run tests
 *   3. commit    — conventional commit message
 *   4. verify    — tests still pass
 *   5. self-audit — no WHAT comments
 *
 * Asserts totalScore >= 0.70 (weighted across phases).
 * Reports per-phase scores regardless of overall pass/fail.
 */

import { materializeDefaultAdapters } from "@dpopsuev/alef-blueprint";
import { createContextAssemblyPipeline } from "@dpopsuev/alef-kernel/pipeline";
import { createToolShellAdapter } from "@dpopsuev/alef-engine";
import { buildLlmAdapter } from "../../../agent/src/build-llm-adapter.js";
import { parseArgs } from "../../../agent/src/args.js";
import { describe, expect, it } from "vitest";
import { fixBugWithCleanCommit } from "../../../core/eval/src/evaluations/git-workflow.js";
import { EvalHarness } from "../../../core/eval/src/harness.js";
import { getEvalModel, SKIP_REAL_LLM } from "../../../core/eval/src/model.js";
import { formatPhaseReport, PhaseEvaluationRunner } from "../../../core/eval/src/phase-runner.js";

describe.skipIf(SKIP_REAL_LLM)("PhaseEvaluation real-LLM — fix bug with clean commit", { tags: ["real-llm"] }, () => {
	it("fixBugWithCleanCommit scores >= 0.70 across five phases", async () => {
		const harness = new EvalHarness();
		const runner = new PhaseEvaluationRunner(harness, {
			asyncAdapterFactory: async (workspace, signal) => {
				const domainAdapters = await materializeDefaultAdapters(workspace);
				const pipeline = createContextAssemblyPipeline();
				const toolShell = createToolShellAdapter({
					tools: domainAdapters.flatMap((o) => o.tools),
					getTools: () => domainAdapters.flatMap((o) => o.tools),
				});
				const model = getEvalModel();
				const llm = buildLlmAdapter({
					model,
					cfg: {},
					args: { ...parseArgs([]), cwd: workspace, noTui: true },
					thinkingState: { level: undefined },
					getModel: () => model,
					getSignal: () => signal,
					schemaResolver: (name) => pipeline.getSchemaResolver()?.(name),
				});
				return [...domainAdapters, toolShell, pipeline, llm];
			},
			scenarioTimeoutMs: 600_000,
		});

		console.log(`\nRunning PhaseEvaluation: ${fixBugWithCleanCommit.id}`);
		console.log(`Model: ${getEvalModel().id}`);

		const result = await runner.run(fixBugWithCleanCommit);

		console.log(`\n${formatPhaseReport(result)}`);

		// Report per-phase breakdown regardless of pass/fail.
		for (const phase of result.phases) {
			console.log(
				`  ${phase.name}: raw=${phase.rawScore.toFixed(2)} ` +
					`final=${phase.finalScore.toFixed(2)} ` +
					`attempts=${phase.attempts} ` +
					`skipped=${phase.skipped}`,
			);
			for (const v of phase.violations) {
				console.log(`    ✗ ${v}`);
			}
		}

		expect(result.totalScore, `totalScore=${result.totalScore.toFixed(3)} (expected >= 0.70)`).toBeGreaterThanOrEqual(
			0.7,
		);
	}, 600_000);
});
