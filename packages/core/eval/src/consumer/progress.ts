import type { ProgressStepSample } from "./types.js";

/** Minimal bus-event shape (EvalHarness BusEvent or BlueprintHarness notifications). */
export interface ProgressBusEvent {
	readonly type?: string;
	readonly bus?: string;
	readonly event?: string;
	readonly payload?: Record<string, unknown>;
}

/** Resolve the event type string from a bus/notification sample. */
function eventType(event: ProgressBusEvent): string {
	return event.type ?? event.event ?? "";
}

/** Coerce unknown payload fields to a finite number or null. */
function num(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Extract ProgressTelemetry step samples from bus/notification events. */
export function extractProgressSteps(events: readonly ProgressBusEvent[]): ProgressStepSample[] {
	const steps: ProgressStepSample[] = [];
	for (const event of events) {
		if (eventType(event) !== "telemetry.progress.step") continue;
		const payload = event.payload ?? {};
		steps.push({
			tokens: num(payload.tokens) ?? 0,
			progress: num(payload.progress),
			tokPerProgress: num(payload.tok_per_progress),
			settleLatencyMs: num(payload.settle_latency_ms),
			correlationId: typeof payload.correlationId === "string" ? payload.correlationId : undefined,
		});
	}
	return steps;
}

/** Average tok/P across steps that have a finite value. */
export function averageTokPerProgress(steps: readonly ProgressStepSample[]): number | null {
	const values = steps
		.map((s) => s.tokPerProgress)
		.filter((v): v is number => v !== null && Number.isFinite(v));
	if (values.length === 0) return null;
	return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Sum of positive progress deltas. */
export function sumProgress(steps: readonly ProgressStepSample[]): number {
	return steps.reduce((acc, s) => acc + Math.max(0, s.progress ?? 0), 0);
}

/** Total tokens attributed on progress steps. */
export function sumProgressTokens(steps: readonly ProgressStepSample[]): number {
	return steps.reduce((acc, s) => acc + s.tokens, 0);
}
