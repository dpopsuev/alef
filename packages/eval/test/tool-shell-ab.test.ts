/**
 * ToolShell A/B evaluation — ALE-TSK-360.
 *
 * Runs the same eval scenarios twice:
 *   A (baseline): standard organ wiring, all schemas upfront
 *   B (ToolShell): tools.search + tools.describe meta-tools only
 *
 * Reports per-scenario: pass, schema_frac, tokens, turns.
 * Decision gate: if pass_rate_B >= pass_rate_A - 0.10, promote ToolShell to default.
 *
 * Requires Vertex credentials (ANTHROPIC_VERTEX_PROJECT_ID).
 * Skipped when no credentials are detected.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFsOrgan } from "../../organ-fs/src/organ.js";
import { Cerebrum } from "../../organ-llm/src/index.js";
import { createShellOrgan } from "../../organ-shell/src/organ.js";
import { buildOrganDirectives, createToolShellOrgan } from "../../runner/src/tool-shell.js";
import type { Evaluation } from "../src/evaluation.js";
import { EvaluationRunner } from "../src/evaluation-runner.js";
import { planRefactoring } from "../src/evaluations/read-only.js";
import { addTypeExport } from "../src/evaluations/write.js";
import { EvalHarness, formatReport } from "../src/harness.js";
import type { RunMetrics } from "../src/metrics.js";
import { getEvalModel, SKIP_REAL_LLM } from "../src/model.js";

// ---------------------------------------------------------------------------
// Scenarios — subset fast enough for A/B (< 3 min each arm)
// ---------------------------------------------------------------------------

const AB_EVALS: Evaluation[] = [addTypeExport, planRefactoring];

// ---------------------------------------------------------------------------
// Shared organs for both arms
// ---------------------------------------------------------------------------

const CWD = "/tmp";

function makeOrgans() {
	return [createFsOrgan({ cwd: CWD }), createShellOrgan({ cwd: CWD })];
}

// ---------------------------------------------------------------------------
// Run one arm
// ---------------------------------------------------------------------------

interface ArmResult {
	scenario: string;
	passed: boolean;
	schemaFrac: number;
	tokens: number;
	turns: number;
	costUsd: number;
}

async function runArm(label: string, evals: Evaluation[], useToolShell: boolean): Promise<ArmResult[]> {
	const results: ArmResult[] = [];

	for (const ev of evals) {
		const harness = new EvalHarness();
		const organs = makeOrgans();

		const toolShell = useToolShell
			? createToolShellOrgan({
					tools: organs.flatMap((o) => o.tools),
					organDirectives: buildOrganDirectives(organs),
				})
			: undefined;

		const runner = new EvaluationRunner(harness, {
			organFactory: (signal) => {
				const llm = new Cerebrum({
					model: getEvalModel(),
					getSignal: () => signal,
				});
				return toolShell ? [...organs, toolShell, llm] : [...organs, llm];
			},
			// When ToolShell is active, pass meta-tools to DialogOrgan.
			...(toolShell ? { getTools: () => [...toolShell.metaTools] } : {}),
		});

		const result = await runner.run(ev);
		const m: RunMetrics = result.metrics;

		const arm: ArmResult = {
			scenario: ev.id,
			passed: result.pass,
			schemaFrac: Number.isNaN(m.avgSchemaFraction) ? 0 : m.avgSchemaFraction,
			tokens: m.turns.reduce((a, t) => a + t.tokensIn + t.tokensOut, 0),
			turns: m.turns.length,
			costUsd: m.turns.reduce((a, t) => a + t.estimatedCostUsd, 0),
		};

		console.log(`\n[${label}] ${formatReport(m)}`);
		results.push(arm);
	}

	return results;
}

// ---------------------------------------------------------------------------
// A/B comparison
// ---------------------------------------------------------------------------

function passRate(results: ArmResult[]): number {
	if (results.length === 0) return 0;
	return results.filter((r) => r.passed).length / results.length;
}

function schemaFracAvg(results: ArmResult[]): number {
	if (results.length === 0) return 0;
	return results.reduce((a, r) => a + r.schemaFrac, 0) / results.length;
}

function totalTokens(results: ArmResult[]): number {
	return results.reduce((a, r) => a + r.tokens, 0);
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

let baselineResults: ArmResult[] = [];
let toolShellResults: ArmResult[] = [];

describe.skipIf(SKIP_REAL_LLM)("ToolShell A/B evaluation (ALE-TSK-360)", () => {
	beforeAll(async () => {
		console.log(`\nA/B eval: model=${getEvalModel().id}  scenarios=${AB_EVALS.length}`);
		[baselineResults, toolShellResults] = await Promise.all([
			runArm("BASELINE", AB_EVALS, false),
			runArm("TOOLSHELL", AB_EVALS, true),
		]);
	}, 600_000);

	afterAll(() => {
		const pA = passRate(baselineResults);
		const pB = passRate(toolShellResults);
		const fracA = schemaFracAvg(baselineResults);
		const fracB = schemaFracAvg(toolShellResults);
		const tokA = totalTokens(baselineResults);
		const tokB = totalTokens(toolShellResults);
		const delta = pB - pA;
		const verdict = delta >= -0.1 ? "PROMOTE ToolShell to default" : "KEEP flag — pass rate degraded";

		console.log("\n=== A/B SUMMARY ===");
		console.log(
			`pass_rate:    baseline=${(pA * 100).toFixed(0)}%  toolshell=${(pB * 100).toFixed(0)}%  delta=${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(0)}%`,
		);
		console.log(`schema_frac:  baseline=${(fracA * 100).toFixed(1)}%  toolshell=${(fracB * 100).toFixed(1)}%`);
		console.log(
			`tokens:       baseline=${tokA}  toolshell=${tokB}  saved=${tokA - tokB} (${tokA > 0 ? ((1 - tokB / tokA) * 100).toFixed(1) : "n/a"}%)`,
		);
		console.log(`verdict:      ${verdict}`);

		for (const ev of AB_EVALS) {
			const a = baselineResults.find((r) => r.scenario === ev.id);
			const b = toolShellResults.find((r) => r.scenario === ev.id);
			if (!a || !b) continue;
			console.log(
				`  ${ev.id}: baseline=${a.passed ? "PASS" : "FAIL"}(${a.tokens}tok,${a.turns}turns)  toolshell=${b.passed ? "PASS" : "FAIL"}(${b.tokens}tok,${b.turns}turns,frac=${(b.schemaFrac * 100).toFixed(1)}%)`,
			);
		}
	});

	it("ToolShell pass rate is within 10% of baseline", () => {
		const pA = passRate(baselineResults);
		const pB = passRate(toolShellResults);
		console.log(`pass_rate: baseline=${(pA * 100).toFixed(0)}%  toolshell=${(pB * 100).toFixed(0)}%`);
		expect(pB).toBeGreaterThanOrEqual(pA - 0.1);
	});

	it("ToolShell reduces avgSchemaFraction vs baseline", () => {
		const fracA = schemaFracAvg(baselineResults);
		const fracB = schemaFracAvg(toolShellResults);
		console.log(`schema_frac: baseline=${(fracA * 100).toFixed(1)}%  toolshell=${(fracB * 100).toFixed(1)}%`);
		// ToolShell meta-schemas are smaller than full domain schemas.
		expect(fracB).toBeLessThan(fracA);
	});

	it("ToolShell reduces total token consumption", () => {
		const tokA = totalTokens(baselineResults);
		const tokB = totalTokens(toolShellResults);
		console.log(`tokens: baseline=${tokA}  toolshell=${tokB}  reduction=${((1 - tokB / tokA) * 100).toFixed(1)}%`);
		expect(tokB).toBeLessThan(tokA);
	});
});
