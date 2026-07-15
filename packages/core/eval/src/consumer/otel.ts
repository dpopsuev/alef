import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { ProgressStepSample } from "./types.js";

const tracer = trace.getTracer("alef.eval.consumer", "0.0.1");

/**
 * Emit one OTLP span per ProgressTelemetry step so CI can assert intensity
 * on the same path as production export (not only bus unit tests).
 */
export function recordProgressSpans(
	steps: readonly ProgressStepSample[],
	attrs: { readonly evalId: string; readonly mode: string },
): void {
	for (const [index, step] of steps.entries()) {
		const span = tracer.startSpan("alef.telemetry.progress.step", {
			attributes: {
				"alef.eval.id": attrs.evalId,
				"alef.eval.mode": attrs.mode,
				"alef.progress.index": index,
				"alef.progress.tokens": step.tokens,
				...(step.progress !== null ? { "alef.progress.p": step.progress } : {}),
				...(step.tokPerProgress !== null
					? { "alef.tok_per_progress": step.tokPerProgress }
					: {}),
				...(step.settleLatencyMs != null
					? { "alef.progress.settle_latency_ms": step.settleLatencyMs }
					: {}),
				...(step.correlationId ? { "alef.correlation_id": step.correlationId } : {}),
			},
		});
		span.setStatus({ code: SpanStatusCode.OK });
		span.end();
	}
}
