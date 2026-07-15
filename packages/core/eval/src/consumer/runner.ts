import { recordProgressSpans } from "./otel.js";
import { scoreConsumerMetrics } from "./score.js";
import type {
	ConsumerEvalAdapter,
	ConsumerEvalMode,
	ConsumerEvalResult,
	ConsumerEvalRunOptions,
} from "./types.js";

/** Run a consumer adapter, score metrics, and mirror progress onto OTLP spans. */
export async function runConsumerEval(
	adapter: ConsumerEvalAdapter,
	opts: ConsumerEvalRunOptions,
): Promise<ConsumerEvalResult> {
	const mode: ConsumerEvalMode = opts.mode;
	const raw = await adapter.run(opts);
	recordProgressSpans(raw.progressSteps, { evalId: adapter.definition.id, mode });

	if (raw.error) {
		return {
			id: adapter.definition.id,
			kind: adapter.definition.kind,
			mode,
			pass: false,
			score: 0,
			metrics: raw.metrics,
			progressSteps: raw.progressSteps,
			durationMs: raw.durationMs,
			costUsd: raw.costUsd,
			error: raw.error,
		};
	}

	const { pass, score } = scoreConsumerMetrics(adapter.definition, raw.metrics);
	return {
		id: adapter.definition.id,
		kind: adapter.definition.kind,
		mode,
		pass,
		score,
		metrics: raw.metrics,
		progressSteps: raw.progressSteps,
		durationMs: raw.durationMs,
		costUsd: raw.costUsd,
	};
}
