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
import type { CheckerResult, Evaluation, ToolCall } from "./evaluation.js";
import type { EvalHarness } from "./harness.js";
import type { HarnessOptions, RunMetrics, SpanRecord } from "./index.js";

/** Result of a single evaluation run including metrics and mustUse violations. */
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

/** Options for the EvaluationRunner controlling error-rate thresholds. */
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

/** Check whether an actual string matches an expected string or RegExp pattern. */
function matchValue(actual: string, expected: string | RegExp): boolean {
	return expected instanceof RegExp ? expected.test(actual) : actual.includes(expected);
}

/** Check whether a span record matches a tool call expectation. */
function matchesToolCall(span: SpanRecord, expectation: ToolCall): boolean {
	const toolName = String(span.attributes["alef.event.type"] ?? "");
	const tools = Array.isArray(expectation.tool) ? expectation.tool : [expectation.tool];
	if (!tools.some((t) => toolName === t)) return false;

	if (expectation.target) {
		const args = span.args ?? {};
		for (const [key, pattern] of Object.entries(expectation.target)) {
			if (pattern === undefined) continue;
			const value = String(args[key] ?? "");
			if (!matchValue(value, pattern)) return false;
		}
	}

	if (expectation.produces !== undefined) {
		const result = span.result ?? "";
		if (!matchValue(result, expectation.produces)) return false;
	}

	return true;
}

/** Format a tool call expectation as a human-readable description. */
function describeExpectation(exp: ToolCall, prefix: string): string {
	const tools = Array.isArray(exp.tool) ? exp.tool.join("|") : exp.tool;
	const target = exp.target
		? ` on ${Object.entries(exp.target)
				.filter(([, v]) => v !== undefined)
				.map(([k, v]) => `${k}=${v instanceof RegExp ? v.source : v}`)
				.join(", ")}`
		: "";
	const produces = exp.produces ? ` → ${exp.produces instanceof RegExp ? exp.produces.source : exp.produces}` : "";
	return `${prefix} ${String(tools)}${target}${produces}`.trim();
}

/** Executes evaluations against the EvalHarness and collects pass/fail metrics. */
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
		const start = Date.now();
		const handle = await this.harness.boot({
			scenario: evaluation.id,
			...this.harnessOptions,
			keepWorkspace: true,
			...(evaluation.scenarioTimeoutMs !== undefined && { scenarioTimeoutMs: evaluation.scenarioTimeoutMs }),
		});

		const scenarioTimeoutMs = evaluation.scenarioTimeoutMs ?? this.harnessOptions.scenarioTimeoutMs ?? 180_000;
		const timeoutPromise = new Promise<never>((_, reject) =>
			setTimeout(() => {
				handle._setError(`scenario timeout after ${scenarioTimeoutMs}ms`, true);
				reject(new Error(`scenario timeout after ${scenarioTimeoutMs}ms`));
			}, scenarioTimeoutMs),
		);

		let passed = false;
		try {
			await Promise.race([
				(async () => {
					for (const file of evaluation.seed ?? []) await handle.writeFile(file.path, file.content);
					const prompts = Array.isArray(evaluation.prompt) ? evaluation.prompt : [evaluation.prompt];
					// eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- prompts narrowed via Array.isArray but TS retains union
					for (const p of prompts) await handle.send(p);
				})(),
				timeoutPromise,
			]);
			passed = true;
		} catch (e) {
			handle._setError(e instanceof Error ? e.message : String(e));
		}

		// Checker runs before dispose so workspace files are still present.
		const workspace = handle.path;
		const spans = handle.spans();
		const lastReply = handle.lastReply;

		try {
			const mustUseErrors: string[] = [];

			for (const expectation of evaluation.expects ?? []) {
				if (!spans.some((s) => matchesToolCall(s, expectation)))
					mustUseErrors.push(describeExpectation(expectation, "Expected"));
			}

			if ((evaluation.expectsAny ?? []).length > 0) {
				const anySatisfied = (evaluation.expectsAny ?? []).some((exp) =>
					spans.some((s) => matchesToolCall(s, exp)),
				);
				if (!anySatisfied) {
					const desc = (evaluation.expectsAny ?? []).map((e) => describeExpectation(e, "")).join(" OR ");
					mustUseErrors.push(`Expected at least one: ${desc}`);
				}
			}

			for (const tool of evaluation.mustNotUse ?? []) {
				const spanName = `alef.command/${tool}`;
				if (spans.some((s) => s.name === spanName))
					mustUseErrors.push(`Expected tool '${tool}' NOT to be called, but it was.`);
			}

			const checkerResult = await evaluation.checker.check({ workspace, spans, lastReply });
			const score = mustUseErrors.length > 0 ? 0 : checkerResult.score;
			const errors = [...mustUseErrors, ...checkerResult.errors];

			const metrics = await handle.dispose(passed);
			return {
				pass: errors.length === 0 && metrics.passed,
				score,
				errors,
				metrics: { ...metrics, scenario: evaluation.id, durationMs: Date.now() - start },
				mustUseErrors,
			};
		} catch (e) {
			await handle.dispose(false);
			throw e;
		} finally {
			await rm(workspace, { recursive: true, force: true }).catch(() => {});
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
