/**
 * Formal plant metric keys shared by Dot (adapter #1) and scoreboard rows.
 * Higher-level scoring lives in score.ts; this only builds the vector.
 */

import {
	averageTokPerProgress,
	extractProgressSteps,
	type ProgressBusEvent,
	sumProgress,
} from "./progress.js";
import type { ConsumerMetricVector, ProgressStepSample } from "./types.js";

/** Canonical plant score keys (Harbor-style metric vector). */
export const PLANT_METRIC_KEYS = [
	"in_circle_ratio",
	"terminal_inside",
	"progress_steps",
	"tok_per_progress",
	"tool_errors",
	"survival_ticks",
] as const;

/** Union of formal plant metric key names. */
export type PlantMetricKey = (typeof PLANT_METRIC_KEYS)[number];

/** Inputs for building a plant metric vector from one episode. */
export interface PlantEpisodeFacts {
	/** Wall-clock ms while the plant reported inside. */
	readonly insideMs: number;
	/** Total wall-clock ms of the episode observation window. */
	readonly totalMs: number;
	/** Final snapshot: agent still inside the goal region. */
	readonly terminalInside: boolean;
	/** Plant ticks survived (Dot: snapshot.tick). */
	readonly survivalTicks: number;
	readonly progressEvents?: readonly ProgressBusEvent[];
	readonly progressSteps?: readonly ProgressStepSample[];
	readonly toolErrorCount?: number;
}

/** Count tool failures from bus/notification events. */
export function countToolErrors(events: readonly ProgressBusEvent[]): number {
	let count = 0;
	for (const event of events) {
		const type = event.type ?? event.event ?? "";
		if (type === "llm.tool-validation-error") {
			count += 1;
			continue;
		}
		if (type !== "llm.tool-end") continue;
		const ok = event.payload?.ok;
		if (ok === false) count += 1;
	}
	return count;
}

/** Build the formal plant metric vector from episode facts + intensity samples. */
export function buildPlantMetrics(facts: PlantEpisodeFacts): {
	metrics: ConsumerMetricVector;
	progressSteps: readonly ProgressStepSample[];
} {
	const progressSteps =
		facts.progressSteps ?? extractProgressSteps(facts.progressEvents ?? []);
	const totalMs = Math.max(0, facts.totalMs);
	const insideMs = Math.max(0, Math.min(facts.insideMs, totalMs || facts.insideMs));
	const inCircleRatio = totalMs > 0 ? insideMs / totalMs : facts.terminalInside ? 1 : 0;

	return {
		progressSteps,
		metrics: {
			in_circle_ratio: inCircleRatio,
			terminal_inside: facts.terminalInside ? 1 : 0,
			progress_steps: progressSteps.length,
			tok_per_progress: averageTokPerProgress(progressSteps),
			tool_errors: facts.toolErrorCount ?? 0,
			survival_ticks: facts.survivalTicks,
			// Convenience for scoreboard / CI (not always thresholded)
			progress_sum: sumProgress(progressSteps),
		},
	};
}
