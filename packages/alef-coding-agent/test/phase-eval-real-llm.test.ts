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

import { createContextAssemblyPipeline } from "@dpopsuev/alef-kernel";
import { createAgentLoop } from "@dpopsuev/alef-organ-llm";
import { describe, expect, it } from "vitest";
import { fixBugWithCleanCommit } from "../../eval/src/evaluations/git-workflow.js";
import { EvalHarness } from "../../eval/src/harness.js";
import { getEvalModel, SKIP_REAL_LLM } from "../../eval/src/model.js";
import { formatPhaseReport, PhaseEvaluationRunner } from "../../eval/src/phase-runner.js";
import { materializeDefaultOrgans } from "@dpopsuev/alef-agent-blueprint";
import { createToolShellOrgan } from "@dpopsuev/alef-organ-toolshell";

describe.skipIf(SKIP_REAL_LLM)("PhaseEvaluation real-LLM — fix bug with clean commit", { tags: ["real-llm"] }, () => {
	it("fixBugWithCleanCommit scores >= 0.70 across five phases", async () => {
		const harness = new EvalHarness();
		const runner = new PhaseEvaluationRunner(harness, {
			asyncOrganFactory: async (workspace, signal) => {
				const domainOrgans = await materializeDefaultOrgans(workspace);
				const pipeline = createContextAssemblyPipeline();
				const toolShell = createToolShellOrgan({
					tools: domainOrgans.flatMap((o) => o.tools),
					getTools: () => domainOrgans.flatMap((o) => o.tools),
				});
				const llm = createAgentLoop({
					model: getEvalModel(),
					getSignal: () => signal,
					schemaResolver: (name) => pipeline.getSchemaResolver()?.(name),
					phaseTimeoutMs: 100,
				});
				return [...domainOrgans, toolShell, pipeline, llm];
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
