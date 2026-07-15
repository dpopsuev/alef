import type { ConsumerBenchmarkDefinition, ConsumerMetricVector, MetricDefinition } from "./types.js";

const DEFAULT_PASS_SCORE = 0.8;

/** True when a metric value is absent or non-finite. */
function isMissing(value: number | null | undefined): boolean {
	return value === null || value === undefined || Number.isNaN(value);
}

/** Whether a metric value meets its passThreshold (if any). */
function metricPasses(def: MetricDefinition, value: number | null | undefined): boolean {
	if (def.passThreshold === undefined) return true;
	if (isMissing(value)) return false;
	return def.higherIsBetter ? value! >= def.passThreshold : value! <= def.passThreshold;
}

/** 0–1 contribution of one metric toward the weighted aggregate score. */
function metricContribution(def: MetricDefinition, value: number | null | undefined): number {
	if (isMissing(value)) return 0;
	if (def.passThreshold === undefined) {
		if (def.format === "percent" || def.format === "ratio") {
			return Math.max(0, Math.min(1, value!));
		}
		return value! > 0 ? 1 : 0;
	}
	return metricPasses(def, value) ? 1 : 0;
}

/** Score a metric vector against the benchmark definition. */
export function scoreConsumerMetrics(
	definition: ConsumerBenchmarkDefinition,
	metrics: ConsumerMetricVector,
): { pass: boolean; score: number; failedKeys: string[] } {
	let weightedSum = 0;
	let weightTotal = 0;
	const failedKeys: string[] = [];

	for (const def of definition.metrics) {
		const value = metrics[def.key];
		if (def.optional && isMissing(value)) continue;

		const weight = def.weight ?? 1;
		weightTotal += weight;
		weightedSum += weight * metricContribution(def, value);
		if (def.passThreshold !== undefined && !metricPasses(def, value)) {
			failedKeys.push(def.key);
		}
	}

	const score = weightTotal > 0 ? weightedSum / weightTotal : 0;
	const required = definition.metrics.filter(
		(m) => m.passThreshold !== undefined && !(m.optional && isMissing(metrics[m.key])),
	);
	const pass = required.length === 0 ? score >= DEFAULT_PASS_SCORE : failedKeys.length === 0;
	return { pass, score, failedKeys };
}
