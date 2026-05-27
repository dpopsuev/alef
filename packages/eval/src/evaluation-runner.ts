/**
 * EvaluationRunner — executes an Evaluation against the EvalHarness.
 *
 * Flow:
 *   1. Seed workspace files
 *   2. Send prompt(s) — one dialog.send() per string in multi-turn
 *   3. Check mustUse / mustNotUse against OTel spans
 *   4. Run checker against workspace + spans + last reply
 *   5. Return EvaluationResult
 *
 * MustUse failure overrides score to 0 regardless of checker result.
 *
 * fixtureCheck(): writes fixture.files to a temp dir and runs the checker.
 * Proves the checker is correct before running real evaluations. No LLM needed.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CheckerResult, Evaluation } from "./evaluation.js";
import { assertToolNotUsed, assertToolUsed, type EvalHarness } from "./harness.js";
import type { HarnessOptions, RunMetrics } from "./index.js";

export interface EvaluationResult extends CheckerResult {
	/** Full run metrics from the EvalHarness. */
	metrics: RunMetrics;
	/** MustUse violations, if any. */
	mustUseErrors: string[];
}

/**
 * Pass@k result for RunN() — statistical summary across n trials.
 *
 * pass_at_k: fraction of trials that passed (0–1).
 * variance: spread of scores across trials.
 * trials: individual EvaluationResults for inspection.
 */
export interface PassAtK {
	evaluation: string;
	n: number;
	pass_at_k: number;
	variance: number;
	min_score: number;
	max_score: number;
	trials: EvaluationResult[];
}

export interface EvaluationRunnerOptions {
	/**
	 * Maximum fraction of trials allowed to have a runtime error (metrics.error set).
	 * If errorRate > maxErrorRate after all trials, RunN throws immediately.
	 * Default: 0 (disabled, backward compatible). Recommended: 0.10.
	 *
	 * Prevents silent zero-score reports where the harness threw on every trial
	 * but PassAtK still returned 0.0 as if it were a valid measurement.
	 *
	 * Mirrors Tako HarnessConfig.MaxErrorRate.
	 */
	maxErrorRate?: number;
}

export class EvaluationRunner {
	private readonly harness: EvalHarness;
	private readonly harnessOptions: Partial<HarnessOptions>;
	private readonly maxErrorRate: number;

	constructor(harness: EvalHarness, options: Partial<HarnessOptions & EvaluationRunnerOptions> = {}) {
		this.harness = harness;
		this.maxErrorRate = options.maxErrorRate ?? 0;
		const { maxErrorRate: _me, ...rest } = options;
		void _me;
		this.harnessOptions = rest;
	}

	async run(evaluation: Evaluation): Promise<EvaluationResult> {
		let lastReply = "";

		// keepWorkspace: checker must read files after agent completes — workspace
		// must outlive EvalHarness.run(). EvaluationRunner owns cleanup.
		const metrics = await this.harness.run(
			async (ctx) => {
				for (const file of evaluation.seed ?? []) {
					await ctx.writeFile(file.path, file.content);
				}

				const prompts = Array.isArray(evaluation.prompt) ? evaluation.prompt : [evaluation.prompt];
				for (const p of prompts) {
					lastReply = await ctx.send(p);
				}
			},
			{
				scenario: evaluation.id,
				...this.harnessOptions,
				keepWorkspace: true,
				// Evaluation-level timeout overrides harness default.
				...(evaluation.scenarioTimeoutMs !== undefined && { scenarioTimeoutMs: evaluation.scenarioTimeoutMs }),
			},
		);

		const workspace = metrics.workspace ?? "";

		try {
			// MustUse / MustNotUse checks.
			const mustUseErrors: string[] = [];
			for (const tool of evaluation.mustUse ?? []) {
				try {
					assertToolUsed(metrics, tool);
				} catch (e) {
					mustUseErrors.push(e instanceof Error ? e.message : String(e));
				}
			}
			for (const tool of evaluation.mustNotUse ?? []) {
				try {
					assertToolNotUsed(metrics, tool);
				} catch (e) {
					mustUseErrors.push(e instanceof Error ? e.message : String(e));
				}
			}

			// Run checker — workspace still alive here.
			const checkerResult = await evaluation.checker.check({
				workspace,
				spans: metrics.spans,
				lastReply,
			});

			const score = mustUseErrors.length > 0 ? 0 : checkerResult.score;
			const errors = [...mustUseErrors, ...checkerResult.errors];

			return {
				pass: errors.length === 0 && metrics.passed,
				score,
				errors,
				metrics,
				mustUseErrors,
			};
		} finally {
			// EvaluationRunner owns cleanup when keepWorkspace was set.
			if (workspace) await rm(workspace, { recursive: true, force: true });
		}
	}

	/**
	 * Run n trials of an evaluation and return pass@k statistics.
	 *
	 * Concurrency is capped at ALEF_EVAL_CONCURRENCY (default 3) to avoid
	 * rate-limiting. Capability evals default to n=5; regression evals to n=1
	 * and should use temperature=0 at the provider level.
	 *
	 * τ-bench finding: 60% pass@1 may mean only 25% consistency across trials.
	 */
	async runN(evaluation: Evaluation, n?: number): Promise<PassAtK> {
		const defaultN = n ?? (evaluation.kind === "capability" ? Number(process.env.ALEF_EVAL_N) || 5 : 1);
		const concurrency = Number(process.env.ALEF_EVAL_CONCURRENCY) || 3;

		const results: EvaluationResult[] = [];
		for (let i = 0; i < defaultN; i += concurrency) {
			const batch = Array.from({ length: Math.min(concurrency, defaultN - i) }, () => this.run(evaluation));
			results.push(...(await Promise.all(batch)));
		}

		// MaxErrorRate gate: fail fast if too many trials had runtime errors.
		if (this.maxErrorRate > 0) {
			const errorCount = results.filter((r) => r.metrics.error !== undefined).length;
			const errorRate = errorCount / results.length;
			if (errorRate > this.maxErrorRate) {
				const firstError = results.find((r) => r.metrics.error)?.metrics.error;
				throw new Error(
					`[MaxErrorRate] ${(errorRate * 100).toFixed(0)}% of trials errored ` +
						`(${errorCount}/${results.length}), threshold ${(this.maxErrorRate * 100).toFixed(0)}%. ` +
						`First error: ${firstError}`,
				);
			}
		}

		const scores = results.map((r) => r.score);
		const passed = results.filter((r) => r.pass).length;
		const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
		const variance = scores.reduce((acc, s) => acc + (s - mean) ** 2, 0) / scores.length;

		return {
			evaluation: evaluation.id,
			n: defaultN,
			pass_at_k: passed / defaultN,
			variance,
			min_score: Math.min(...scores),
			max_score: Math.max(...scores),
			trials: results,
		};
	}

	/**
	 * Fixture check — run the checker against known-good files without any LLM.
	 * Throws if score < 0.9. Use in CI fixture-tests.
	 */
	static async fixtureCheck(evaluation: Evaluation): Promise<void> {
		if (!evaluation.fixture) {
			throw new Error(`Evaluation '${evaluation.id}' has no fixture`);
		}

		const workspace = join(tmpdir(), `alef-fixture-${evaluation.id}-${Date.now()}`);
		await mkdir(workspace, { recursive: true });

		try {
			for (const [path, content] of Object.entries(evaluation.fixture.files)) {
				const abs = join(workspace, path);
				await mkdir(dirname(abs), { recursive: true });
				await writeFile(abs, content, "utf-8");
			}

			const result = await evaluation.checker.check({
				workspace,
				spans: [],
				lastReply: "",
			});

			if (result.score < 0.9) {
				throw new Error(
					`Fixture check failed for '${evaluation.id}': score=${result.score}\n${result.errors.join("\n")}`,
				);
			}
		} finally {
			await rm(workspace, { recursive: true, force: true });
		}
	}
}
