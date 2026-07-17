/**
 * Trajectory-level harness metrics from bus/turn traces.
 * Binding Constraint / survey: RR(k), control-lag τ proxies.
 */

import type { BusEvent, TurnRecord } from "./metrics.js";

/** Default recovery window in subsequent LLM turns. */
export const DEFAULT_RECOVERY_WINDOW_K = 3;

/** Aggregated trajectory metrics for a single eval run. */
export interface TrajectoryMetrics {
	/** Fraction of tool errors followed by a successful tool call within k turns (0–1). */
	recoveryRateK: number | null;
	/** k used for RR(k). */
	recoveryWindowK: number;
	/** Count of tool-error events used as RR denominators. */
	toolErrorCount: number;
	/** Count of those errors recovered within k turns. */
	recoveredCount: number;
	/**
	 * Mean control lag τ in ms: anomaly (tool error) → next corrective observation
	 * (successful tool end). null when no paired samples.
	 */
	controlLagMs: number | null;
	/** Sample count for controlLagMs. */
	controlLagSamples: number;
}

/** Prefer explicit llm.tool-end bus events; fall back to error-flagged event messages. */
function collectErrorAndSuccess(busEvents: readonly BusEvent[]): {
	errors: { index: number }[];
	successes: { index: number }[];
} {
	const errors: { index: number }[] = [];
	const successes: { index: number }[] = [];
	busEvents.forEach((event, index) => {
		if (event.event === "llm.tool-end") {
			const ok = event.payload?.ok !== false && event.isError !== true;
			if (ok) successes.push({ index });
			else errors.push({ index });
			return;
		}
		if ((event.bus === "event" || event.bus === "notification") && event.isError) {
			errors.push({ index });
		}
	});
	return { errors, successes };
}

/** Infer turn index progression: each llm.response advances the turn. */
function turnAtBusIndex(busEvents: readonly BusEvent[], index: number): number {
	let turn = 0;
	for (let i = 0; i <= index && i < busEvents.length; i++) {
		const event = busEvents[i]!;
		if (event.event === "llm.response" || event.event === "llm.input") turn++;
	}
	return Math.max(1, turn);
}

/**
 * Compute RR(k) and mean control-lag from captured bus events.
 * `_turns` reserved for future Context Retention / HV-MV join.
 */
export function computeTrajectoryMetrics(
	busEvents: readonly BusEvent[],
	_turns: readonly TurnRecord[] = [],
	recoveryWindowK: number = DEFAULT_RECOVERY_WINDOW_K,
): TrajectoryMetrics {
	const { errors, successes } = collectErrorAndSuccess(busEvents);
	if (errors.length === 0) {
		return {
			recoveryRateK: null,
			recoveryWindowK,
			toolErrorCount: 0,
			recoveredCount: 0,
			controlLagMs: null,
			controlLagSamples: 0,
		};
	}

	let recoveredCount = 0;
	const lags: number[] = [];

	for (const error of errors) {
		const errorTurn = turnAtBusIndex(busEvents, error.index);
		const nextSuccess = successes.find((success) => success.index > error.index);
		if (!nextSuccess) continue;
		const successTurn = turnAtBusIndex(busEvents, nextSuccess.index);
		if (successTurn - errorTurn <= recoveryWindowK) {
			recoveredCount++;
			const errorEvent = busEvents[error.index]!;
			const successEvent = busEvents[nextSuccess.index]!;
			if (errorEvent.elapsedMs !== undefined && successEvent.elapsedMs !== undefined) {
				lags.push(Math.max(0, successEvent.elapsedMs - errorEvent.elapsedMs));
			} else {
				lags.push(Math.max(0, nextSuccess.index - error.index));
			}
		}
	}

	return {
		recoveryRateK: recoveredCount / errors.length,
		recoveryWindowK,
		toolErrorCount: errors.length,
		recoveredCount,
		controlLagMs: lags.length > 0 ? lags.reduce((a, b) => a + b, 0) / lags.length : null,
		controlLagSamples: lags.length,
	};
}

/** One-line summary for reports. */
export function formatTrajectoryMetricsLine(metrics: TrajectoryMetrics): string {
	const rr =
		metrics.recoveryRateK === null
			? "RR=n/a"
			: `RR(${metrics.recoveryWindowK})=${metrics.recoveryRateK.toFixed(2)} (${metrics.recoveredCount}/${metrics.toolErrorCount})`;
	const lag =
		metrics.controlLagMs === null ? "τ=n/a" : `τ=${Math.round(metrics.controlLagMs)}ms (n=${metrics.controlLagSamples})`;
	return `${rr} ${lag}`;
}

/** Cell key for Attention×model factorial grids. */
export function factorialCellKey(compaction: string, model: string): string {
	return `${compaction}×${model}`;
}

/**
 * Ranking-reversal helper: true when pass-rate order of two cells flips
 * vs a reference ordering (e.g. summarize vs attention on model A).
 */
export function rankingReversal(
	passRates: ReadonlyMap<string, number>,
	cellA: string,
	cellB: string,
	referenceOrder: "a_beats_b" | "b_beats_a",
): boolean {
	const a = passRates.get(cellA);
	const b = passRates.get(cellB);
	if (a === undefined || b === undefined) return false;
	const aBeatsB = a > b;
	return referenceOrder === "a_beats_b" ? !aBeatsB : aBeatsB;
}
