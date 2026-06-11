import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EvaluationRunner } from "../../eval/src/evaluation-runner.js";
import { ALL_TERMINAL_BENCH } from "../../eval/src/evaluations/terminal-bench.js";
import { EvalHarness } from "../../eval/src/harness.js";
import { SKIP_REAL_LLM } from "../../eval/src/model.js";

describe.skipIf(SKIP_REAL_LLM)("terminal bench — agent resolves coding tasks", { tags: ["real-llm"] }, () => {
	let harness: EvalHarness;
	const results: Array<{ id: string; score: number; passed: boolean }> = [];

	beforeAll(() => {
		harness = new EvalHarness();
	});

	afterAll(() => {
		console.log("\nTerminalBench results:");
		for (const r of results) {
			console.log(`  ${r.id}: score=${r.score.toFixed(2)} ${r.passed ? "pass" : "fail"}`);
		}
		const resolved = results.filter((r) => r.passed).length;
		console.log(`\nResolved: ${resolved}/${results.length} (${((resolved / results.length) * 100).toFixed(0)}%)`);
	});

	for (const evaluation of ALL_TERMINAL_BENCH) {
		it(`${evaluation.id} — agent resolves task`, async () => {
			const runner = new EvaluationRunner(harness, {
				systemPrompt:
					"You are a precise coding assistant. Complete the task in the current directory. " +
					"Always use tools to read and write files — never guess.",
				extraOrgans: [],
			});
			const result = await runner.run(evaluation);
			results.push({ id: evaluation.id, score: result.score, passed: result.pass });
			console.log(`  ${evaluation.id}: score=${result.score.toFixed(2)} errors=${result.errors.join("; ")}`);
			expect(result.score).toBeGreaterThanOrEqual(0);
		}, 120_000);
	}
});
