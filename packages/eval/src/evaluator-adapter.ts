/**
 * EvaluatorAdapter — Observer organ for evaluation runs.
 *
 * Wires directly to nerve.command.subscribe("*") and nerve.event.subscribe("*")
 * to count all events and detect tool call loops.
 *
 * Loop detection: same Motor event type > loopThreshold times within the same
 * correlationId → sets loopDetected, calls onLoop callback.
 *
 * Does NOT publish events — read-only observer.
 */

import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import type { Bus, BusMessage } from "@dpopsuev/alef-kernel/bus";

export interface EvaluatorAdapterOptions {
	/**
	 * How many times the same Motor event type on the same correlationId
	 * triggers loop detection. Default: 10.
	 */
	loopThreshold?: number;
	/** Called when a loop is detected. */
	onLoop?: (eventType: string, correlationId: string, count: number) => void;
}

export interface EvaluatorAdapterState {
	commandCount: number;
	eventCount: number;
	loopDetected: boolean;
	loopEventType?: string;
}

export class EvaluatorAdapter implements Adapter {
	readonly name = "evaluator";
	readonly tools = [] as const;
	readonly subscriptions = { command: ["*"] as const, event: ["*"] as const, notification: [] as const };
	readonly sources = [] as const;

	private readonly threshold: number;
	private readonly onLoop?: EvaluatorAdapterOptions["onLoop"];
	// Map<correlationId, Map<eventType, count>>
	private readonly counts = new Map<string, Map<string, number>>();

	readonly state: EvaluatorAdapterState = {
		commandCount: 0,
		eventCount: 0,
		loopDetected: false,
	};

	constructor(options: EvaluatorAdapterOptions = {}) {
		this.threshold = options.loopThreshold ?? 10;
		this.onLoop = options.onLoop;
	}

	mount(bus: Bus): () => void {
		const offMotor = bus.command.subscribe("*", (event: BusMessage) => {
			this.state.commandCount++;
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

		const offSense = bus.event.subscribe("*", (_event: BusMessage) => {
			this.state.eventCount++;
		});

		return () => {
			offMotor();
			offSense();
			this.counts.clear();
		};
	}
}
