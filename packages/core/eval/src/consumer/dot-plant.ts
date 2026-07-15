/**
 * Dot plant — consumer eval adapter #1 (episode in → metric vector out).
 *
 * Lives in eval (not tool-dot) so the Dot adapter package stays kernel+zod only.
 * Episode drivers are injected (scripted BlueprintHarness or live LLM).
 */

import { buildPlantMetrics, countToolErrors } from "./plant-metrics.js";
import type {
	ConsumerBenchmarkDefinition,
	ConsumerEvalAdapter,
	ConsumerEvalMode,
	ConsumerEvalRaw,
	ConsumerEvalRunOptions,
} from "./types.js";
import type { ProgressBusEvent } from "./progress.js";

/** Formal Dot plant metrics for scoreboard + CI thresholds. */
export const DOT_PLANT_DEFINITION: ConsumerBenchmarkDefinition = {
	kind: "plant",
	id: "dot-circle",
	label: "Dot-in-circle plant",
	metrics: [
		{
			key: "terminal_inside",
			label: "Terminal inside",
			format: "ratio",
			higherIsBetter: true,
			passThreshold: 1,
			weight: 2,
		},
		{
			key: "in_circle_ratio",
			label: "In-circle time",
			format: "ratio",
			higherIsBetter: true,
			passThreshold: 0.8,
			weight: 2,
		},
		{
			key: "progress_steps",
			label: "Progress steps",
			format: "number",
			higherIsBetter: true,
			passThreshold: 1,
			weight: 1,
		},
		{
			key: "tok_per_progress",
			label: "tok/P",
			format: "number",
			higherIsBetter: false,
			passThreshold: 1_000,
			weight: 1,
			optional: true,
		},
		{
			key: "tool_errors",
			label: "Tool errors",
			format: "number",
			higherIsBetter: false,
			passThreshold: 0,
			weight: 1,
		},
		{
			key: "survival_ticks",
			label: "Survival ticks",
			format: "number",
			higherIsBetter: true,
			passThreshold: 1,
			weight: 0.5,
		},
	],
};

/** Duck-typed Dot episode outcome (matches tool-dot EpisodeResult). */
export interface DotPlantEpisodeOutcome {
	readonly final: { readonly inside: boolean; readonly status: string; readonly tick: number };
	readonly insideMs: number;
	readonly totalMs: number;
}

/** Raw facts a Dot episode driver must return. */
export interface DotConsumerEpisode {
	readonly episode: DotPlantEpisodeOutcome;
	readonly events: readonly ProgressBusEvent[];
	readonly costUsd?: number;
}

/**
 * Mode-aware driver — scripted regression and live-LLM share this contract.
 */
export type DotConsumerDriver = (
	mode: ConsumerEvalMode,
	signal?: AbortSignal,
) => Promise<DotConsumerEpisode>;

/** Score Dot episode facts into a consumer metric vector. */
export function scoreDotEpisode(input: DotConsumerEpisode & { readonly durationMs: number }): ConsumerEvalRaw {
	const { episode, events, durationMs, costUsd } = input;
	const { metrics, progressSteps } = buildPlantMetrics({
		insideMs: episode.insideMs,
		totalMs: episode.totalMs,
		terminalInside: episode.final.inside && episode.final.status === "ok",
		survivalTicks: episode.final.tick,
		progressEvents: events,
		toolErrorCount: countToolErrors(events),
	});
	return {
		metrics,
		progressSteps,
		durationMs,
		...(costUsd !== undefined && { costUsd }),
	};
}

/** Harbor-style Dot plant adapter: episode in → metric vector out. */
export function createDotConsumerEval(driver: DotConsumerDriver): ConsumerEvalAdapter {
	return {
		definition: DOT_PLANT_DEFINITION,
		async run(opts: ConsumerEvalRunOptions): Promise<ConsumerEvalRaw> {
			const started = Date.now();
			try {
				const episode = await driver(opts.mode, opts.signal);
				return scoreDotEpisode({
					...episode,
					durationMs: Date.now() - started,
				});
			} catch (error) {
				return {
					metrics: {
						terminal_inside: 0,
						in_circle_ratio: 0,
						progress_steps: 0,
						tok_per_progress: null,
						tool_errors: 0,
						survival_ticks: 0,
					},
					progressSteps: [],
					durationMs: Date.now() - started,
					error: error instanceof Error ? error.message : String(error),
				};
			}
		},
	};
}
