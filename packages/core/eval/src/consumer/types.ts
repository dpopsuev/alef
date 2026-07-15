/**
 * Consumer eval — Harbor-style plant/benchmark kinds.
 *
 * Coding ToolUse_* suites stay on EvaluationRunner.
 * Plants (Dot first) implement ConsumerEvalAdapter: episode in → metric vector out.
 */

/** Benchmark family — coding remains on the classic runner; plants use consumer. */
export type ConsumerKind = "plant" | "coding" | (string & {});

/** How the consumer episode is driven. */
export type ConsumerEvalMode = "scripted" | "live";

/** One scorable metric in a consumer benchmark. */
export interface MetricDefinition {
	readonly key: string;
	readonly label: string;
	readonly format: "percent" | "number" | "ratio" | "usd" | "ms";
	readonly higherIsBetter: boolean;
	/** When set, pass requires value ≥ threshold (or ≤ when !higherIsBetter). */
	readonly passThreshold?: number;
	/** Weight in aggregate score (default 1). */
	readonly weight?: number;
	/**
	 * When true, a null/missing value skips this metric for pass + score
	 * (scripted paths may lack tok/P while still emitting progress steps).
	 */
	readonly optional?: boolean;
}

/** Static description of a consumer benchmark (like Harbor BenchmarkDefinition). */
export interface ConsumerBenchmarkDefinition {
	readonly kind: ConsumerKind;
	readonly id: string;
	readonly label: string;
	readonly metrics: readonly MetricDefinition[];
}

/** One ProgressTelemetry step sample (bus or OTLP-derived). */
export interface ProgressStepSample {
	readonly tokens: number;
	readonly progress: number | null;
	readonly tokPerProgress: number | null;
	readonly settleLatencyMs?: number | null;
	readonly correlationId?: string;
}

/** Named metric values produced by one episode. */
export type ConsumerMetricVector = Readonly<Record<string, number | null>>;

/** Result of running one consumer adapter episode. */
export interface ConsumerEvalResult {
	readonly id: string;
	readonly kind: ConsumerKind;
	readonly mode: ConsumerEvalMode;
	readonly pass: boolean;
	/** Aggregate 0–1 score from weighted metric thresholds. */
	readonly score: number;
	readonly metrics: ConsumerMetricVector;
	readonly progressSteps: readonly ProgressStepSample[];
	readonly durationMs: number;
	readonly costUsd?: number;
	readonly error?: string;
}

/** Options passed into a consumer adapter run. */
export interface ConsumerEvalRunOptions {
	readonly mode: ConsumerEvalMode;
	readonly signal?: AbortSignal;
}

/** Raw adapter output before scoring. */
export interface ConsumerEvalRaw {
	readonly metrics: ConsumerMetricVector;
	readonly progressSteps: readonly ProgressStepSample[];
	readonly durationMs: number;
	readonly costUsd?: number;
	readonly error?: string;
}

/**
 * Pluggable plant/consumer benchmark.
 * Dot implements this in @dpopsuev/alef-tool-dot — eval stays plant-agnostic.
 */
export interface ConsumerEvalAdapter {
	readonly definition: ConsumerBenchmarkDefinition;
	run(opts: ConsumerEvalRunOptions): Promise<ConsumerEvalRaw>;
}
