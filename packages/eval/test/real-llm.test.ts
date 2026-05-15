/**
 * TSK-117 — Real-LLM evaluation suite.
 *
 * 14 scenarios across ReadOnly, Write, and MultiTurn categories.
 * Skipped entirely if ANTHROPIC_API_KEY is not set.
 *
 * Run: cd packages/eval && npx vitest --run test/real-llm.test.ts
 * Override model: ALEF_EVAL_MODEL=claude-haiku-4-5 npx vitest --run test/real-llm.test.ts
 */

import { LLMOrgan } from "@dpopsuev/alef-organ-llm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunMetrics } from "../src/index.js";
import { EvalHarness, formatReport, scoreSpans } from "../src/index.js";
import { READ_ONLY_RULES, WRITE_RULES } from "../src/metrics.js";
import { getEvalModel, SKIP_REAL_LLM } from "../src/model.js";
import * as multiTurn from "../src/scenarios/multi-turn.js";
import * as readOnly from "../src/scenarios/read-only.js";
import * as write from "../src/scenarios/write.js";

// ---------------------------------------------------------------------------
// System prompt — coding assistant with tool discipline
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a precise coding assistant. You have access to filesystem tools.

Rules:
- Always read files before modifying them.
- Make minimal, targeted edits. Do not rewrite files unless asked.
- When asked to create a file, write it immediately using fs.write or fs.edit.
- When asked to analyse code, use fs.read or fs.grep to examine the actual files.
- Reply concisely. No apologies, no filler.`;

// ---------------------------------------------------------------------------
// Harness + LLM setup
// ---------------------------------------------------------------------------

function makeLLMOrgan() {
	return new LLMOrgan({ model: getEvalModel() });
}

function makeHarness() {
	return new EvalHarness();
}

// ---------------------------------------------------------------------------
// Results accumulator (for final report)
// ---------------------------------------------------------------------------

const allResults: RunMetrics[] = [];

beforeAll(() => {
	if (SKIP_REAL_LLM) console.log("⚠ ANTHROPIC_API_KEY not set — skipping real-LLM suite");
	else console.log(`Running real-LLM suite with model: ${getEvalModel().id}`);
});

afterAll(() => {
	if (SKIP_REAL_LLM) return;

	console.log("\n═══ EVALUATION REPORT ═══\n");
	let passed = 0;
	for (const m of allResults) {
		console.log(formatReport(m));
		if (m.passed) passed++;
	}
	console.log(`\nTotal: ${passed}/${allResults.length} passed`);

	const totalOAE = allResults.reduce((sum, m) => sum + m.oae, 0) / allResults.length;
	console.log(`Avg OAE: ${(totalOAE * 100).toFixed(1)}%`);
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

async function runScenario(
	name: string,
	scenarioFn: Parameters<EvalHarness["run"]>[0],
	rules = READ_ONLY_RULES,
): Promise<RunMetrics> {
	const harness = makeHarness();
	const metrics = await harness.run(scenarioFn, {
		scenario: name,
		extraOrgans: [makeLLMOrgan()],
		systemPrompt: SYSTEM_PROMPT,
		loopThreshold: 12,
	});
	allResults.push(metrics);
	const score = scoreSpans(metrics.spans, rules);
	console.log(`  score=${score}  oae=${(metrics.oae * 100).toFixed(1)}%`);
	return metrics;
}

// ---------------------------------------------------------------------------
// ReadOnly scenarios
// ---------------------------------------------------------------------------

describe.skipIf(SKIP_REAL_LLM)("ReadOnly scenarios", () => {
	it("PlanRefactoring — reads file, produces concrete refactoring plan", async () => {
		const m = await runScenario("PlanRefactoring", readOnly.planRefactoring);
		expect(m.passed, m.error).toBe(true);
	});

	it("AuditModule — reads file, identifies dead code", async () => {
		const m = await runScenario("AuditModule", readOnly.auditModule);
		expect(m.passed, m.error).toBe(true);
	});

	it("BlastRadius — reads two files, traces change impact", async () => {
		const m = await runScenario("BlastRadius", readOnly.blastRadius);
		expect(m.passed, m.error).toBe(true);
	});

	it("ContextWarming — reads multiple files, answers cross-file question", async () => {
		const m = await runScenario("ContextWarming", readOnly.contextWarming);
		expect(m.passed, m.error).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Write scenarios
// ---------------------------------------------------------------------------

describe.skipIf(SKIP_REAL_LLM)("Write scenarios", () => {
	it("CreateHTTPServer — creates file with correct structure", async () => {
		const m = await runScenario("CreateHTTPServer", write.createHTTPServer, WRITE_RULES);
		expect(m.passed, m.error).toBe(true);
	});

	it("AddTypeExport — adds missing export to existing file", async () => {
		const m = await runScenario("AddTypeExport", write.addTypeExport, WRITE_RULES);
		expect(m.passed, m.error).toBe(true);
	});

	it("FixFailingTest — finds bug, fixes implementation", async () => {
		const m = await runScenario("FixFailingTest", write.fixFailingTest, WRITE_RULES);
		expect(m.passed, m.error).toBe(true);
	});

	it("RefactorAsync — refactors callbacks to async/await", async () => {
		const m = await runScenario("RefactorAsync", write.refactorAsync, WRITE_RULES);
		expect(m.passed, m.error).toBe(true);
	});

	it("WriteMiddleware — creates new middleware file", async () => {
		const m = await runScenario("WriteMiddleware", write.writeMiddleware, WRITE_RULES);
		expect(m.passed, m.error).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// MultiTurn scenarios
// ---------------------------------------------------------------------------

describe.skipIf(SKIP_REAL_LLM)("MultiTurn scenarios", () => {
	it("ProposeFirst — proposes approach then implements on approval", async () => {
		const m = await runScenario("ProposeFirst", multiTurn.proposeFirst, WRITE_RULES);
		expect(m.passed, m.error).toBe(true);
	});

	it("MemoRecall — uses information from earlier turn", async () => {
		const m = await runScenario("MemoRecall", multiTurn.memoRecall, WRITE_RULES);
		expect(m.passed, m.error).toBe(true);
	});

	it("ApproveProposal — asks for clarification then implements correctly", async () => {
		const m = await runScenario("ApproveProposal", multiTurn.approveProposal, WRITE_RULES);
		expect(m.passed, m.error).toBe(true);
	});
});
