/**
 * ProgressTelemetry — required operational intensity telemetry (Token per Progress).
 *
 * Always-on instrumentation (LoopGuard / SessionLog class), not an optional domain adapter.
 * Joins llm.token-usage with Gap from ErrorTensor (DSS − AC). No DSS → P = null.
 */

import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import type { Bus, CommandMessage, EventMessage, NotificationMessage } from "@dpopsuev/alef-kernel/bus";
import { newCorrelationId } from "@dpopsuev/alef-kernel/bus";

/** Gap snapshot used for Progress (P) = max(0, Gap_before − Gap_after). */
export interface GapSnapshot {
	readonly totalMagnitude: number;
	readonly converged: boolean;
}

/** Options for ProgressTelemetry. */
export interface ProgressTelemetryOptions {
	/** Read current gap; null when no DSS / ErrorTensor. */
	readonly getGap?: () => GapSnapshot | null;
}

interface OpenStep {
	correlationId: string;
	gapBefore: number | null;
	tokensIn: number;
	tokensOut: number;
	tokensTotal: number;
	observeLatencyMs: number;
	actuateLatencyMs: number;
	toolStartedAt: number | null;
	openedAt: number;
}

interface OutcomeRollup {
	tokensIn: number;
	tokensOut: number;
	tokensTotal: number;
	progress: number;
	steps: number;
	gapStart: number | null;
	gapLatest: number | null;
	converged: boolean;
}

/** Compute Progress and tok/P; P null when gap unavailable. */
export function computeTokPerProgress(
	tokens: number,
	gapBefore: number | null,
	gapAfter: number | null,
): { progress: number | null; tokPerProgress: number | null } {
	if (gapBefore === null || gapAfter === null) {
		return { progress: null, tokPerProgress: null };
	}
	const progress = Math.max(0, gapBefore - gapAfter);
	if (progress <= 0) {
		return { progress, tokPerProgress: null };
	}
	return { progress, tokPerProgress: tokens / progress };
}

/** Required ops telemetry: step + outcome Token-per-Progress events. */
export class ProgressTelemetry implements Adapter {
	readonly name = "progress-telemetry";
	readonly tools = [] as const;
	readonly subscriptions = {
		command: [] as const,
		event: [] as const,
		notification: [] as const,
	};
	readonly sources = [] as const;

	private readonly getGap: () => GapSnapshot | null;
	private step: OpenStep | null = null;
	private outcome: OutcomeRollup = emptyOutcome();

	constructor(opts: ProgressTelemetryOptions = {}) {
		this.getGap = opts.getGap ?? (() => null);
	}

	mount(bus: Bus): () => void {
		const offInput = bus.event.subscribe("llm.input", (event: EventMessage) => {
			this.openStep(event.correlationId);
		});

		const offUsage = bus.notification.subscribe("llm.token-usage", (event: NotificationMessage) => {
			this.onTokenUsage(event);
		});

		const offToolStart = bus.notification.subscribe("llm.tool-start", (event: NotificationMessage) => {
			if (!this.step || event.correlationId !== this.step.correlationId) return;
			this.step.toolStartedAt = Date.now();
		});

		const offToolEnd = bus.notification.subscribe("llm.tool-end", (event: NotificationMessage) => {
			if (!this.step || event.correlationId !== this.step.correlationId) return;
			const elapsed = typeof event.payload.elapsedMs === "number" ? event.payload.elapsedMs : 0;
			const name = typeof event.payload.name === "string" ? event.payload.name : "";
			if (name.includes("observe") || name.endsWith(".observe")) {
				this.step.observeLatencyMs += elapsed;
			} else {
				this.step.actuateLatencyMs += elapsed;
			}
			this.step.toolStartedAt = null;
		});

		const offResponse = bus.command.subscribe("llm.response", (event: CommandMessage) => {
			this.closeStep(bus, event.correlationId);
		});

		const offResult = bus.notification.subscribe("llm.result", (event: NotificationMessage) => {
			// Prefer llm.response; llm.result is a fallback when response is absent.
			if (this.step && this.step.correlationId === event.correlationId) {
				this.closeStep(bus, event.correlationId);
			}
		});

		return () => {
			offInput();
			offUsage();
			offToolStart();
			offToolEnd();
			offResponse();
			offResult();
			const open = this.step;
			if (open) {
				this.closeStep(bus, open.correlationId);
			}
			if (this.outcome.steps > 0) {
				this.publishOutcome(bus, open?.correlationId ?? newCorrelationId());
			}
		};
	}

	private openStep(correlationId: string): void {
		if (this.step && this.step.correlationId !== correlationId) {
			// Prior step closed without response — drop open state; tokens already in outcome if closed.
			this.step = null;
		}
		const gap = this.getGap();
		this.step = {
			correlationId,
			gapBefore: gap?.totalMagnitude ?? null,
			tokensIn: 0,
			tokensOut: 0,
			tokensTotal: 0,
			observeLatencyMs: 0,
			actuateLatencyMs: 0,
			toolStartedAt: null,
			openedAt: Date.now(),
		};
		if (this.outcome.gapStart === null && gap) {
			this.outcome.gapStart = gap.totalMagnitude;
		}
	}

	private onTokenUsage(event: NotificationMessage): void {
		if (!this.step) {
			this.openStep(event.correlationId);
		}
		if (!this.step || event.correlationId !== this.step.correlationId) return;
		const usage = event.payload.usage;
		if (!usage || typeof usage !== "object") return;
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- bus protocol: llm.token-usage usage shape
		const u = usage as Record<string, unknown>;
		const input = typeof u.input === "number" ? u.input : 0;
		const output = typeof u.output === "number" ? u.output : 0;
		const total =
			typeof u.totalTokens === "number" ? u.totalTokens : input + output;
		this.step.tokensIn += input;
		this.step.tokensOut += output;
		this.step.tokensTotal += total;
	}

	private closeStep(bus: Bus, correlationId: string): void {
		const step = this.step;
		if (!step || step.correlationId !== correlationId) return;
		this.step = null;

		const gapAfterSnap = this.getGap();
		const gapAfter = gapAfterSnap?.totalMagnitude ?? null;
		const { progress, tokPerProgress } = computeTokPerProgress(
			step.tokensTotal,
			step.gapBefore,
			gapAfter,
		);
		const settleLatencyMs = Date.now() - step.openedAt;

		bus.notification.publish({
			type: "telemetry.progress.step",
			payload: {
				correlationId: step.correlationId,
				tokens_in: step.tokensIn,
				tokens_out: step.tokensOut,
				tokens: step.tokensTotal,
				gap_before: step.gapBefore,
				gap_after: gapAfter,
				progress,
				tok_per_progress: tokPerProgress,
				observe_latency_ms: step.observeLatencyMs,
				actuate_latency_ms: step.actuateLatencyMs,
				settle_latency_ms: settleLatencyMs,
				converged: gapAfterSnap?.converged ?? null,
			},
			correlationId: step.correlationId,
		});

		this.outcome.tokensIn += step.tokensIn;
		this.outcome.tokensOut += step.tokensOut;
		this.outcome.tokensTotal += step.tokensTotal;
		this.outcome.steps += 1;
		if (progress !== null) this.outcome.progress += progress;
		this.outcome.gapLatest = gapAfter;
		if (gapAfterSnap?.converged) {
			this.outcome.converged = true;
			this.publishOutcome(bus, step.correlationId);
		}
	}

	private publishOutcome(bus: Bus, correlationId: string): void {
		const { progress, tokPerProgress } = computeTokPerProgress(
			this.outcome.tokensTotal,
			this.outcome.gapStart,
			this.outcome.gapLatest,
		);
		// Prefer summed step progress when available; else gap-delta over outcome window.
		const outcomeProgress =
			this.outcome.progress > 0 ? this.outcome.progress : progress;
		const outcomeTokPer =
			outcomeProgress !== null && outcomeProgress > 0
				? this.outcome.tokensTotal / outcomeProgress
				: tokPerProgress;

		bus.notification.publish({
			type: "telemetry.progress.outcome",
			payload: {
				tokens_in: this.outcome.tokensIn,
				tokens_out: this.outcome.tokensOut,
				tokens: this.outcome.tokensTotal,
				gap_start: this.outcome.gapStart,
				gap_latest: this.outcome.gapLatest,
				progress: outcomeProgress,
				tok_per_progress: outcomeTokPer,
				steps: this.outcome.steps,
				converged: this.outcome.converged,
			},
			correlationId,
		});
		this.outcome = emptyOutcome();
	}
}

/** Empty outcome rollup for a new ProgressTelemetry episode. */
function emptyOutcome(): OutcomeRollup {
	return {
		tokensIn: 0,
		tokensOut: 0,
		tokensTotal: 0,
		progress: 0,
		steps: 0,
		gapStart: null,
		gapLatest: null,
		converged: false,
	};
}
