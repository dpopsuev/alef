import { EvalBaseline, type RegressionReport } from "../baseline.js";
import { runConsumerEval } from "./runner.js";
import type {
	ConsumerEvalAdapter,
	ConsumerEvalMode,
	ConsumerEvalResult,
	ConsumerEvalRunOptions,
} from "./types.js";

/** One consumer suite run (scripted regression or live-LLM). */
export interface ConsumerSuiteReport {
	readonly mode: ConsumerEvalMode;
	readonly results: readonly ConsumerEvalResult[];
	readonly nPass: number;
	readonly nTotal: number;
	readonly meanScore: number;
	readonly meanDurationMs: number;
	readonly meanCostUsd: number | null;
	readonly regressions: readonly RegressionReport[];
}

/** Options for the shared consumer runner/baseline API. */
export interface ConsumerSuiteOptions extends ConsumerEvalRunOptions {
	readonly adapters: readonly ConsumerEvalAdapter[];
	/** When set, load/save EvalBaseline and report regressions. */
	readonly baselinePath?: string;
	/** Persist updated baseline after the run (default true when baselinePath set). */
	readonly updateBaseline?: boolean;
	readonly regressionThreshold?: number;
}

/**
 * Productized harness: scripted + live share one runner and optional baseline.
 * Coding ToolUse_* stays on EvaluationRunner; plants use this.
 */
export async function runConsumerSuite(opts: ConsumerSuiteOptions): Promise<ConsumerSuiteReport> {
	const results: ConsumerEvalResult[] = [];
	for (const adapter of opts.adapters) {
		results.push(
			await runConsumerEval(adapter, {
				mode: opts.mode,
				signal: opts.signal,
			}),
		);
	}

	const nTotal = results.length;
	const nPass = results.filter((r) => r.pass).length;
	const meanScore = nTotal > 0 ? results.reduce((a, r) => a + r.score, 0) / nTotal : 0;
	const meanDurationMs = nTotal > 0 ? results.reduce((a, r) => a + r.durationMs, 0) / nTotal : 0;
	const costs = results.map((r) => r.costUsd).filter((c): c is number => typeof c === "number");
	const meanCostUsd = costs.length > 0 ? costs.reduce((a, b) => a + b, 0) / costs.length : null;

	let regressions: RegressionReport[] = [];
	if (opts.baselinePath) {
		const baseline = await EvalBaseline.load(opts.baselinePath);
		const current = new Map(results.map((r) => [r.id, { score: r.score }]));
		regressions = baseline.regressions(current, opts.regressionThreshold ?? 0.8); // eslint-disable-line no-magic-numbers -- default EvalBaseline threshold
		if (opts.updateBaseline !== false) {
			for (const result of results) {
				baseline.record(result.id, { pass: result.pass, score: result.score });
			}
			await baseline.save(opts.baselinePath);
		}
	}

	return {
		mode: opts.mode,
		results,
		nPass,
		nTotal,
		meanScore,
		meanDurationMs,
		meanCostUsd,
		regressions,
	};
}
