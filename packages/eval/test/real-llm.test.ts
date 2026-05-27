/**
 * Real-LLM evaluation suite.
 *
 * 12 Evaluation objects across ReadOnly, Write, and MultiTurn categories.
 * Uses EvaluationRunner (new API) — proper checkers, MaxErrorRate gate,
 * and clean beforeEach span assertion.
 *
 * Skipped entirely if no provider credentials are detected.
 *
 * Run:
 *   cd packages/eval
 *   ANTHROPIC_API_KEY=sk-ant-... npx vitest --run test/real-llm.test.ts
 *
 * Override model:
 *   ALEF_EVAL_MODEL=claude-haiku-4-5 npx vitest --run test/real-llm.test.ts
 */

import { Cerebrum } from "@dpopsuev/alef-organ-llm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as multiTurnEvals from "../src/evaluations/multi-turn.js";
import * as readOnlyEvals from "../src/evaluations/read-only.js";
import * as writeEvals from "../src/evaluations/write.js";
import type { EvaluationResult } from "../src/index.js";
import { EvalHarness, EvaluationRunner } from "../src/index.js";
import { getEvalModel, SKIP_REAL_LLM } from "../src/model.js";
import { globalSpanExporter } from "../src/otel-setup.js";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeAll(() => {
	if (SKIP_REAL_LLM) console.log("No provider credentials — skipping real-LLM suite");
	else console.log(`Real-LLM suite: model=${getEvalModel().id}`);
});

/**
 * Before each test: assert the span exporter is clean.
 * Catches contamination from concurrent tests or leaked runs.
 * The EvalHarness.run() resets the exporter at the start of each run,
 * but if two tests somehow ran concurrently this assertion fires first.
 */
beforeEach(() => {
	const leaked = globalSpanExporter.getFinishedSpans().length;
	if (leaked > 0) {
		globalSpanExporter.reset();
		throw new Error(
			`[beforeEach] globalSpanExporter had ${leaked} leaked spans from a previous test. ` +
				`Tests must not run concurrently — check vitest config.`,
		);
	}
});

// ---------------------------------------------------------------------------
// Runner factory — fresh harness + cerebrum per test for isolation
// ---------------------------------------------------------------------------

function makeRunner() {
	const harness = new EvalHarness();
	const llm = new Cerebrum({ model: getEvalModel() });
	return new EvaluationRunner(harness, {
		extraOrgans: [llm],
		// Fail the suite if >30% of trials have runtime errors.
		// n=1 here so this catches a single hard crash.
		maxErrorRate: 0.3,
	});
}

// ---------------------------------------------------------------------------
// Results accumulator — per-describe, not module-level
// ---------------------------------------------------------------------------

const allResults: EvaluationResult[] = [];

afterAll(() => {
	if (SKIP_REAL_LLM || allResults.length === 0) return;

	const passed = allResults.filter((r) => r.pass).length;
	const scores = allResults.map((r) => r.score);
	const meanScore = scores.reduce((a, b) => a + b, 0) / scores.length;

	console.log(`\n═══ REAL-LLM REPORT ═══`);
	console.log(`Passed: ${passed}/${allResults.length}`);
	console.log(`Mean score: ${(meanScore * 100).toFixed(1)}%`);
	console.log(
		`OAE (mean): ${((allResults.reduce((a, r) => a + r.metrics.oae, 0) / allResults.length) * 100).toFixed(1)}%`,
	);
	for (const r of allResults) {
		const icon = r.pass ? "✓" : "✗";
		const errs = r.errors.length > 0 ? ` — ${r.errors.join("; ")}` : "";
		console.log(`  ${icon} ${r.metrics.scenario} score=${(r.score * 100).toFixed(0)}%${errs}`);
	}
});

// ---------------------------------------------------------------------------
// ReadOnly
// ---------------------------------------------------------------------------

describe.skipIf(SKIP_REAL_LLM)("ReadOnly evaluations", () => {
	it("PlanRefactoring — reads file, produces concrete refactoring plan", async () => {
		const result = await makeRunner().run(readOnlyEvals.planRefactoring);
		allResults.push(result);
		expect(result.pass, result.errors.join("; ")).toBe(true);
	});

	it("AuditModule — reads file, identifies dead code", async () => {
		const result = await makeRunner().run(readOnlyEvals.auditModule);
		allResults.push(result);
		expect(result.pass, result.errors.join("; ")).toBe(true);
	});

	it("BlastRadius — reads two files, traces change impact", async () => {
		const result = await makeRunner().run(readOnlyEvals.blastRadius);
		allResults.push(result);
		expect(result.pass, result.errors.join("; ")).toBe(true);
	});

	it("ContextWarming — reads multiple files, answers cross-file question", async () => {
		const result = await makeRunner().run(readOnlyEvals.contextWarming);
		allResults.push(result);
		expect(result.pass, result.errors.join("; ")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

describe.skipIf(SKIP_REAL_LLM)("Write evaluations", () => {
	it("CreateHTTPServer — creates file with correct structure", async () => {
		const result = await makeRunner().run(writeEvals.createHTTPServer);
		allResults.push(result);
		expect(result.pass, result.errors.join("; ")).toBe(true);
	});

	it("AddTypeExport — adds missing export to existing file", async () => {
		const result = await makeRunner().run(writeEvals.addTypeExport);
		allResults.push(result);
		expect(result.pass, result.errors.join("; ")).toBe(true);
	});

	it("FixFailingTest — finds bug, fixes implementation", async () => {
		const result = await makeRunner().run(writeEvals.fixFailingTest);
		allResults.push(result);
		expect(result.pass, result.errors.join("; ")).toBe(true);
	});

	it("RefactorAsync — refactors callbacks to async/await", async () => {
		const result = await makeRunner().run(writeEvals.refactorAsync);
		allResults.push(result);
		expect(result.pass, result.errors.join("; ")).toBe(true);
	});

	it("WriteMiddleware — creates new middleware file", async () => {
		const result = await makeRunner().run(writeEvals.writeMiddleware);
		allResults.push(result);
		expect(result.pass, result.errors.join("; ")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// MultiTurn
// ---------------------------------------------------------------------------

describe.skipIf(SKIP_REAL_LLM)("MultiTurn evaluations", () => {
	it("ProposeFirst — proposes approach then implements on approval", async () => {
		const result = await makeRunner().run(multiTurnEvals.proposeFirst);
		allResults.push(result);
		expect(result.pass, result.errors.join("; ")).toBe(true);
	});

	it("MemoRecall — uses information from earlier turn", async () => {
		const result = await makeRunner().run(multiTurnEvals.memoRecall);
		allResults.push(result);
		expect(result.pass, result.errors.join("; ")).toBe(true);
	});

	it("ApproveProposal — asks for clarification then implements correctly", async () => {
		const result = await makeRunner().run(multiTurnEvals.approveProposal);
		allResults.push(result);
		expect(result.pass, result.errors.join("; ")).toBe(true);
	});
});
