/**
 * ToolShell A/B evaluation.
 *
 * Runs the same eval scenarios twice:
 *   A (baseline): standard adapter wiring, all schemas upfront
 *   B (ToolShell): tools.search + tools.describe meta-tools only
 *
 * Reports per-scenario: pass, schema_frac, tokens, turns.
 * Decision gate: if pass_rate_B >= pass_rate_A - 0.10, promote ToolShell to default.
 *
 * Requires Vertex credentials (ANTHROPIC_VERTEX_PROJECT_ID).
 * Skipped when no credentials are detected.
 */

import { createFsAdapter } from "@dpopsuev/alef-tool-fs";
import { createShellAdapter } from "@dpopsuev/alef-tool-shell";
import { buildAdapterDirectives, createToolShellAdapter } from "@dpopsuev/alef-runtime";
import { buildLlmAdapter } from "../../../agent/src/build-llm-adapter.js";
import { parseArgs } from "../../../agent/src/args.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Evaluation } from "../../../core/eval/src/evaluation.js";
import { EvaluationRunner } from "../../../core/eval/src/evaluation-runner.js";
import { addTypeExport, createHTTPServer } from "../../../core/eval/src/evaluations/write.js";
import { EvalHarness } from "../../../core/eval/src/harness.js";
import type { RunMetrics } from "../../../core/eval/src/metrics.js";
import { getEvalModel, SKIP_REAL_LLM } from "../../../core/eval/src/model.js";
import { formatReport } from "../../../core/eval/src/report.js";

// ---------------------------------------------------------------------------
// Scenarios — subset fast enough for A/B (< 3 min each arm)
// ---------------------------------------------------------------------------

// createHTTPServer requires actual code generation (mustUse: fs.write).
// addTypeExport requires reading + editing (mustUse: fs.read).
// Both require real LLM work — neither passes trivially on seed state.
const AB_EVALS: Evaluation[] = [createHTTPServer, addTypeExport];

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

		// Representative organs for schema snapshot (cwd doesn’t affect schema shape).
		const repOrgans = [createFsAdapter({ cwd: "/tmp" }), createShellAdapter({ cwd: "/tmp" })];
		const toolShell = useToolShell
			? createToolShellAdapter({
					tools: repOrgans.flatMap((o) => o.tools),
					adapterDirectives: buildAdapterDirectives(repOrgans),
				})
			: undefined;

		const runner = new EvaluationRunner(harness, {
			// Domain organs (fs, shell) are loaded by the harness with the correct workspace cwd.
			// adapterFactory adds only the LLM (and ToolShellOrgan when active).
			// phaseTimeoutMs=100 activates context.assemble for catalog lifecycle injection.
			adapterFactory: (signal) => {
				const model = getEvalModel();
				const llm = buildLlmAdapter({
					model,
					cfg: {},
					args: { ...parseArgs([]), noTui: true, cwd: "." },
					thinkingState: { level: undefined },
					getModel: () => model,
					getSignal: () => signal,
				});
				return toolShell ? [toolShell, llm] : [llm];
			},
			...(toolShell ? { getTools: () => toolShell.currentMetaTools() } : {}),
			scenarioTimeoutMs: 300_000,
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

describe.skipIf(SKIP_REAL_LLM)("ToolShell A/B: schema-on-demand vs all-upfront", { tags: ["real-llm"] }, () => {
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

	it("ToolShell schema_frac is lower than baseline schema_frac", () => {
		// ToolShell sends fewer schema tokens per call (meta-tools vs full schemas).
		// Total tokens may be higher due to extra search+describe turns on short tasks.
		// Break-even favours ToolShell on long tasks (10+ turns, many tool calls).
		const fracA = schemaFracAvg(baselineResults);
		const fracB = schemaFracAvg(toolShellResults);
		console.log(
			`schema_frac: baseline=${(fracA * 100).toFixed(1)}%  toolshell=${(fracB * 100).toFixed(1)}%  (lower = fewer schema tokens per call)`,
		);
		expect(fracB).toBeLessThan(fracA);
	});
});
