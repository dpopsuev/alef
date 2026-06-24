/**
 * Real-LLM evaluation suite.
 *
 * Each evaluation is its own it() — vitest reports per-test progress.
 * Tests run sequentially within the describe (LLM rate limits).
 *
 * Run:
 *   ALEF_TEST_LLM=1 npx vitest run --tags-filter=real-llm packages/profiles/coding/test/evaluations.test.ts
 *   ALEF_TEST_LLM=1 npx vitest run -t "ToolUse" packages/profiles/coding/test/evaluations.test.ts
 */

import { resolve } from "node:path";

import { createAgentLoop } from "@dpopsuev/alef-reasoner";
import { InMemorySessionStore } from "@dpopsuev/alef-testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Evaluation } from "../../../core/eval/src/evaluation.js";
import * as multiTurnEvals from "../../../core/eval/src/evaluations/multi-turn.js";
import * as readOnlyEvals from "../../../core/eval/src/evaluations/read-only.js";
import * as toolUseEvals from "../../../core/eval/src/evaluations/tool-use-regression.js";
import * as writeEvals from "../../../core/eval/src/evaluations/write.js";
import type { EvaluationResult } from "../../../core/eval/src/index.js";
import { EvalHarness, EvaluationRunner } from "../../../core/eval/src/index.js";
import { getEvalModel, SKIP_REAL_LLM } from "../../../core/eval/src/model.js";
import { appendRunRecord, buildRunRecord, loadRunHistory, writeScoreboard } from "../../../core/eval/src/scoreboard.js";
import { createCodingAgentStack } from "../src/index.js";

const BENCHMARK_PATH = resolve(__dirname, "../../../core/eval/benchmark.jsonl");
const SCOREBOARD_PATH = resolve(__dirname, "../../../core/eval/SCOREBOARD.md");

const ALL_EVALS: Evaluation[] = [
	readOnlyEvals.planRefactoring,
	readOnlyEvals.auditModule,
	readOnlyEvals.blastRadius,
	readOnlyEvals.contextWarming,
	writeEvals.createHTTPServer,
	writeEvals.addTypeExport,
	writeEvals.fixFailingTest,
	writeEvals.refactorAsync,
	writeEvals.writeMiddleware,
	multiTurnEvals.proposeFirst,
	multiTurnEvals.memoRecall,
	multiTurnEvals.approveProposal,
	toolUseEvals.singleToolCall,
	toolUseEvals.multiToolCall,
	toolUseEvals.grepThenRead,
	toolUseEvals.complexMultiTool,
];

function stubFactory(modelId: string, contextWindow: number) {
	return () => ({
		state: { id: "eval", modelId, contextWindow },
		getModel: () => modelId,
		setModel: () => {},
		getThinking: () => "off" as const,
		setThinking: () => {},
		setTurnController: () => {},
		subscribe: () => () => {},
		send: async () => "",
		dispose: () => {},
	});
}

async function runEval(evaluation: Evaluation): Promise<EvaluationResult> {
	const harness = new EvalHarness();
	const model = getEvalModel();
	const runner = new EvaluationRunner(harness, {
		asyncAdapterFactory: async (workspace, signal) => {
			const sessionStore = new InMemorySessionStore();
			const stack = await createCodingAgentStack({
				cwd: workspace,
				model,
				getSignal: () => signal,
				sessionStore,
				subagentFactory: stubFactory(model.id, model.contextWindow),
			});
			const llm = createAgentLoop({
				model,
				getSignal: () => signal,
				schemaResolver: (name) => stack.pipeline.getSchemaResolver()?.(name),
				phaseTimeoutMs: 100,
			});
			return [...stack.adapters, llm];
		},
		maxErrorRate: 0.5,
	});
	return runner.run(evaluation);
}

const allResults: EvaluationResult[] = [];

describe.skipIf(SKIP_REAL_LLM)("coding agent evaluations", { tags: ["real-llm"] }, () => {
	beforeAll(() => {
		console.log(`Real-LLM suite: model=${getEvalModel().id}`);
	});

	for (const evaluation of ALL_EVALS) {
		it(evaluation.id, async () => {
			const result = await runEval(evaluation);
			allResults.push(result);

			if (!result.pass) {
				const errors = result.errors.join("; ");
				expect.fail(`${evaluation.id}: score=${(result.score * 100).toFixed(0)}% — ${errors}`);
			}
		}, 300_000);
	}

	afterAll(async () => {
		if (allResults.length === 0) return;

		const passed = allResults.filter((r) => r.pass).length;
		const meanScore = allResults.reduce((a, r) => a + r.score, 0) / allResults.length;

		console.log(`\n╔═══ REAL-LLM REPORT ═══`);
		console.log(`Passed: ${passed}/${allResults.length}  Mean score: ${(meanScore * 100).toFixed(1)}%`);
		for (const r of allResults) {
			const icon = r.pass ? "✓" : "✗";
			const err = r.errors[0] ? ` — ${r.errors[0].slice(0, 80)}` : "";
			console.log(`  ${icon} ${r.metrics.scenario} score=${(r.score * 100).toFixed(0)}%${err}`);
		}

		const model = getEvalModel();
		const record = buildRunRecord(
			model.id,
			model.provider ?? "unknown",
			allResults.map((r) => ({
				id: r.metrics.scenario,
				pass: r.pass,
				score: r.score,
				error: r.errors[0],
				durationMs: r.metrics.durationMs,
				oae: r.metrics.oae,
			})),
		);
		await appendRunRecord(BENCHMARK_PATH, record);
		const history = await loadRunHistory(BENCHMARK_PATH);
		await writeScoreboard(SCOREBOARD_PATH, history);
		console.log(`Scoreboard updated — ${history.length} run(s) recorded.`);
	});
});
