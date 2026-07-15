import type { Agent } from "@dpopsuev/alef-engine/agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Evaluation } from "./evaluation.js";
import type { EvaluationResult } from "./evaluation-runner.js";
import { EvaluationRunner } from "./evaluation-runner.js";
import { EvalHarness } from "./harness.js";
import { codingUsageMetrics } from "./metrics.js";
import { getEvalModel, SKIP_REAL_LLM } from "./model.js";
import { appendRunRecord, buildRunRecord, loadRunHistory, writeScoreboard } from "./scoreboard.js";

/** Configuration for defining an evaluation suite. */
export interface EvalSuiteOptions {
	name: string;
	evals: Evaluation[];
	agentFactory: (workspace: string, signal: AbortSignal) => Promise<Agent>;
	benchmarkPath?: string;
	scoreboardPath?: string;
	timeoutMs?: number;
	tags?: string[];
}

/** Create a stub session factory for eval harness bootstrapping without a real LLM. */
export function stubSessionFactory(modelId: string, contextWindow: number) {
	return () => ({
		state: { id: "eval", modelId, contextWindow },
		getModel: () => modelId,
		setModel: () => {},
		getThinking: () => "off" as const,
		setThinking: () => {},
		setTurnController: () => {},
		subscribe: () => () => {},
		// eslint-disable-next-line @typescript-eslint/require-await
		send: async () => "",
		dispose: () => {},
	});
}

/** Print a formatted results table to stdout (tokens, cost, tok/P included). */
function formatResultTable(results: EvaluationResult[]): void {
	const disclosure = process.env.ALEF_TOOL_DISCLOSURE ?? "full";
	const passed = results.filter((r) => r.pass).length;
	const total = results.length;
	const meanScore = results.reduce((a, r) => a + r.score, 0) / total;
	const model = results.find((r) => r.metrics.model)?.metrics.model ?? getEvalModel().id;

	// eslint-disable-next-line no-magic-numbers
	const nameWidth = Math.max(...results.map((r) => r.metrics.scenario.length), 8);
	const header = `${"Eval".padEnd(nameWidth)}  Score  Time     Turns  Tools  Tokens    Cost      tok/P`;
	const divider = "─".repeat(header.length);

	console.log(`\n╔═══ EVAL REPORT (model=${model} disclosure=${disclosure}) ═══╗`);
	console.log(header);
	console.log(divider);
	for (const r of results) {
		const icon = r.pass ? "✓" : "✗";
		const name = r.metrics.scenario.padEnd(nameWidth);
		// eslint-disable-next-line no-magic-numbers
		const score = `${(r.score * 100).toFixed(0)}%`.padStart(4);
		// eslint-disable-next-line no-magic-numbers
		const time = `${(r.metrics.durationMs / 1000).toFixed(1)}s`.padStart(6);
		// eslint-disable-next-line no-magic-numbers
		const turns = String(r.metrics.turns.length).padStart(5);
		// eslint-disable-next-line no-magic-numbers
		const tools = String(r.metrics.turns.reduce((a, t) => a + t.toolCalls, 0)).padStart(5);
		// eslint-disable-next-line no-magic-numbers
		const tokens = String(r.metrics.tokensIn + r.metrics.tokensOut).padStart(6);
		// eslint-disable-next-line no-magic-numbers
		const cost = `$${r.metrics.costUsd.toFixed(4)}`.padStart(9);
		const tokP =
			r.metrics.tokPerProgress === null
				? // eslint-disable-next-line no-magic-numbers
					"n/a".padStart(6)
				: // eslint-disable-next-line no-magic-numbers
					r.metrics.tokPerProgress.toFixed(1).padStart(6);
		// eslint-disable-next-line no-magic-numbers
		const err = r.pass ? "" : `  ${r.errors[0]?.slice(0, 60) ?? ""}`;
		console.log(`${icon} ${name}  ${score}  ${time}  ${turns}  ${tools}  ${tokens}  ${cost}  ${tokP}${err}`);
	}
	console.log(divider);
	const totalCost = results.reduce((a, r) => a + r.metrics.costUsd, 0);
	const totalTokens = results.reduce((a, r) => a + r.metrics.tokensIn + r.metrics.tokensOut, 0);
	console.log(
		// eslint-disable-next-line no-magic-numbers
		`  ${passed}/${total} passed  mean=${(meanScore * 100).toFixed(1)}%  total=${(results.reduce((a, r) => a + r.metrics.durationMs, 0) / 1000).toFixed(1)}s  tokens=${totalTokens}  cost=$${totalCost.toFixed(4)}`,
	);
}

/** Register a vitest eval suite with scoreboard tracking and result reporting. */
export function defineEvalSuite(opts: EvalSuiteOptions): void {
	const allResults: EvaluationResult[] = [];
	// eslint-disable-next-line no-magic-numbers
	const timeoutMs = opts.timeoutMs ?? 300_000;

	// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-unsafe-argument -- vitest describe options type is too narrow for tags
	describe.skipIf(SKIP_REAL_LLM)(opts.name, { tags: opts.tags ?? ["real-llm"] } as any, () => {
		beforeAll(() => {
			console.log(`${opts.name}: model=${getEvalModel().id}`);
		});

		for (const evaluation of opts.evals) {
			it(evaluation.id, async () => {
				const harness = new EvalHarness();
				const runner = new EvaluationRunner(harness, {
					agentFactory: opts.agentFactory,
					maxErrorRate: 0.5,
				});
				const result = await runner.run(evaluation);
				allResults.push(result);

				if (!result.pass) {
					const errors = result.errors.join("; ");
					// eslint-disable-next-line no-magic-numbers
					expect.fail(`${evaluation.id}: score=${(result.score * 100).toFixed(0)}% — ${errors}`);
				}
			}, timeoutMs);
		}

		afterAll(async () => {
			if (allResults.length === 0) return;
			formatResultTable(allResults);

			if (opts.benchmarkPath && opts.scoreboardPath) {
				const model = getEvalModel();
				const record = buildRunRecord(
					model.id,
					model.provider,
					allResults.map((r) => ({
						id: r.metrics.scenario,
						pass: r.pass,
						score: r.score,
						error: r.errors[0],
						durationMs: r.metrics.durationMs,
						costUsd: r.metrics.costUsd,
						oae: r.metrics.oae,
						kind: "coding" as const,
						metrics: codingUsageMetrics(r.metrics),
					})),
				);
				await appendRunRecord(opts.benchmarkPath, record);
				const history = await loadRunHistory(opts.benchmarkPath);
				await writeScoreboard(opts.scoreboardPath, history);
				console.log(`Scoreboard updated — ${history.length} run(s) recorded.`);
			}
		});
	});
}
