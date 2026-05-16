/**
 * EvaluatorOrgan — Observer organ for evaluation runs.
 *
 * Wires directly to nerve.motor.subscribe("*") and nerve.sense.subscribe("*")
 * to count all events and detect tool call loops.
 *
 * Loop detection: same Motor event type > loopThreshold times within the same
 * correlationId → sets loopDetected, calls onLoop callback.
 *
 * Does NOT publish events — read-only observer.
 */

import type { Nerve, NerveEvent, Organ } from "@dpopsuev/alef-spine";

export interface EvaluatorOrganOptions {
	/**
	 * How many times the same Motor event type on the same correlationId
	 * triggers loop detection. Default: 10.
	 */
	loopThreshold?: number;
	/** Called when a loop is detected. */
	onLoop?: (eventType: string, correlationId: string, count: number) => void;
}

export interface EvaluatorOrganState {
	motorCount: number;
	senseCount: number;
	loopDetected: boolean;
	loopEventType?: string;
}

export class EvaluatorOrgan implements Organ {
	readonly name = "evaluator";
	readonly tools = [] as const;
	readonly subscriptions = { motor: ["*"] as const, sense: ["*"] as const };

	private readonly threshold: number;
	private readonly onLoop?: EvaluatorOrganOptions["onLoop"];
	// Map<correlationId, Map<eventType, count>>
	private readonly counts = new Map<string, Map<string, number>>();

	readonly state: EvaluatorOrganState = {
		motorCount: 0,
		senseCount: 0,
		loopDetected: false,
	};

	constructor(options: EvaluatorOrganOptions = {}) {
		this.threshold = options.loopThreshold ?? 10;
		this.onLoop = options.onLoop;
	}

	mount(nerve: Nerve): () => void {
		const offMotor = nerve.motor.subscribe("*", (event: NerveEvent) => {
			this.state.motorCount++;
			if (this.state.loopDetected) return;

			let byType = this.counts.get(event.correlationId);
			if (!byType) {
				byType = new Map();
				this.counts.set(event.correlationId, byType);
			}
			const count = (byType.get(event.type) ?? 0) + 1;
			byType.set(event.type, count);

			if (count > this.threshold) {
				this.state.loopDetected = true;
				this.state.loopEventType = event.type;
				this.onLoop?.(event.type, event.correlationId, count);
			}
		});

		const offSense = nerve.sense.subscribe("*", (_event: NerveEvent) => {
			this.state.senseCount++;
		});

		return () => {
			offMotor();
			offSense();
			this.counts.clear();
		};
	}
}
