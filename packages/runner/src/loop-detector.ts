/**
 * LoopDetectorOrgan — lightweight production loop guard.
 *
 * Subscribes to all Motor events via wildcard. When the same event type fires
 * more than `threshold` times within a single correlationId, it throws an
 * error that surfaces to the user and aborts the current turn.
 *
 * Separate from eval's EvaluatorOrgan (which is metrics-focused).
 * This is the production safety net.
 */

import type { Nerve, Organ } from "@dpopsuev/alef-spine";

export interface LoopDetectorOptions {
	/** How many repeated calls of the same event type trigger the guard. Default: 15. */
	threshold?: number;
	/** Called when a loop is detected. Default: print to stderr. */
	onLoop?: (eventType: string, count: number) => void;
}

export class LoopDetectorOrgan implements Organ {
	readonly name = "loop-detector";
	readonly tools = [];
	readonly subscriptions = { motor: ["*"], sense: [] };

	private readonly threshold: number;
	private readonly onLoop: (eventType: string, count: number) => void;

	constructor(opts: LoopDetectorOptions = {}) {
		this.threshold = opts.threshold ?? 15;
		this.onLoop =
			opts.onLoop ??
			((type, count) => {
				process.stderr.write(
					`\n[loop-detector] Tool '${type}' called ${count} times — possible infinite loop. Aborting turn.\n`,
				);
			});
	}

	mount(nerve: Nerve): () => void {
		// Counts per correlationId — cleared when correlationId changes.
		const counts = new Map<string, Map<string, number>>();
		let lastCorrelationId: string | undefined;

		const off = nerve.motor.subscribe("*", (event) => {
			const corr = event.correlationId ?? "none";

			// Reset counters on new correlation (new user turn).
			if (corr !== lastCorrelationId) {
				counts.clear();
				lastCorrelationId = corr;
			}

			let perCorr = counts.get(corr);
			if (!perCorr) {
				perCorr = new Map();
				counts.set(corr, perCorr);
			}

			const prev = perCorr.get(event.type) ?? 0;
			const next = prev + 1;
			perCorr.set(event.type, next);

			if (next > this.threshold) {
				this.onLoop(event.type, next);
				// Publish a sense error so the LLM sees the problem.
				nerve.sense.publish({
					type: event.type,
					payload: {},
					isError: true,
					errorMessage: `Loop detected: '${event.type}' called ${next} times in one turn. Stop repeating this tool.`,
					correlationId: corr,
					timestamp: Date.now(),
				});
			}
		});

		return () => {
			off();
			counts.clear();
		};
	}
}
