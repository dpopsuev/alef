/**
 * Real-LLM evaluation suite.
 *
 * Each evaluation is its own it() — vitest reports per-test progress.
 * Uses the production LLM adapter (buildLlmAdapter) to match the
 * interactive session path exactly.
 *
 * Run:
 *   ALEF_TEST_LLM=1 npx vitest run --tags-filter=real-llm packages/profiles/coding/test/evaluations.test.ts
 *   ALEF_TEST_LLM=1 npx vitest run -t "ToolUse" packages/profiles/coding/test/evaluations.test.ts
 */

import { resolve } from "node:path";

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
import { buildAgent } from "../../../agent/src/agent-kernel.js";
import { buildLlmAdapter } from "../../../agent/src/build-llm-adapter.js";
import { parseArgs } from "../../../agent/src/args.js";
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
	toolUseEvals.writeFile,
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
	const args = { ...parseArgs([]), noTui: true };
	const runner = new EvaluationRunner(harness, {
		agentFactory: async (workspace, signal) => {
			const sessionStore = new InMemorySessionStore();
			const stack = await createCodingAgentStack({
				cwd: workspace,
				model,
				getSignal: () => signal,
				sessionStore,
				subagentFactory: stubFactory(model.id, model.contextWindow),
			});
			const llm = buildLlmAdapter({
				model,
				cfg: {},
				args: { ...args, cwd: workspace },
				thinkingState: { level: undefined },
				getModel: () => model,
				getSignal: () => signal,
				schemaResolver: (name) => stack.pipeline.getSchemaResolver()?.(name),
			});
			const agent = buildAgent({
				llm,
				loopThreshold: 10,
				onLoop: (_type, reason) => { console.warn(`[eval] loop detected: ${reason}`); },
			});
			for (const adapter of stack.adapters) agent.load(adapter);
			return agent;
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
		const total = allResults.length;
		const meanScore = allResults.reduce((a, r) => a + r.score, 0) / total;
		const disclosure = process.env.ALEF_TOOL_DISCLOSURE ?? "full";

		const nameWidth = Math.max(...allResults.map((r) => r.metrics.scenario.length), 8);
		const header = `${"Eval".padEnd(nameWidth)}  Score  Time     Turns  Tools  Tokens`;
		const divider = "─".repeat(header.length);

		console.log(`\n╔═══ REAL-LLM REPORT (disclosure=${disclosure}) ═══╗`);
		console.log(header);
		console.log(divider);
		for (const r of allResults) {
			const icon = r.pass ? "✓" : "✗";
			const name = r.metrics.scenario.padEnd(nameWidth);
			const score = `${(r.score * 100).toFixed(0)}%`.padStart(4);
			const time = `${(r.metrics.durationMs / 1000).toFixed(1)}s`.padStart(6);
			const turns = String(r.metrics.turns.length).padStart(5);
			const tools = String(r.metrics.turns.reduce((a, t) => a + t.toolCalls, 0)).padStart(5);
			const tokens = String(r.metrics.turns.reduce((a, t) => a + t.tokensIn + t.tokensOut, 0)).padStart(6);
			const err = r.pass ? "" : `  ${r.errors[0]?.slice(0, 60) ?? ""}`;
			console.log(`${icon} ${name}  ${score}  ${time}  ${turns}  ${tools}  ${tokens}${err}`);
		}
		console.log(divider);
		console.log(`  ${passed}/${total} passed  mean=${(meanScore * 100).toFixed(1)}%  total=${(allResults.reduce((a, r) => a + r.metrics.durationMs, 0) / 1000).toFixed(1)}s`);

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
