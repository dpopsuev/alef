/**
 * EventLogOrgan — tap Motor and Sense buses, write every event to the session JSONL.
 *
 * Same wildcard pattern as EvaluatorOrgan: subscribes motor/* and sense/*.
 * Writes each event as a StorageRecord to the session file (fire-and-forget).
 *
 * This is the missing link between the EDA bus and the persistent event log.
 * Once wired, the TurnAssembler (ALE-TSK-179) can read the full event history
 * and build accurate context windows without relying on DialogOrgan.history[].
 *
 * Not a CorpusOrgan — no tools, no subscriptions via defineOrgan.
 * Implements Organ directly (same as EvaluatorOrgan).
 *
 * Ref: ALE-SPC-15, ALE-TSK-178
 */

import type { Nerve, Organ } from "@dpopsuev/alef-spine";
import { redactPayload } from "./redact.js";
import type { SessionStore } from "./session-store.js";
import { hashRecord } from "./session-store.js";

export class EventLogOrgan implements Organ {
	readonly name = "event-log";
	readonly tools = [] as const;
	readonly subscriptions = {
		motor: ["*"] as const,
		sense: ["*"] as const,
	};

	private readonly store: SessionStore;

	constructor(store: SessionStore) {
		this.store = store;
	}

	mount(nerve: Nerve): () => void {
		const off1 = nerve.motor.subscribe("*", (event) => {
			// Redact sensitive fields then hash before writing.
			const payload = redactPayload(event.payload) as Record<string, unknown>;
			const base = {
				bus: "motor" as const,
				type: event.type,
				correlationId: event.correlationId,
				payload,
				timestamp: event.timestamp,
			};
			void this.store.append({ ...base, hash: hashRecord(base) });
		});

		const off2 = nerve.sense.subscribe("*", (event) => {
			const payload = redactPayload(event.payload) as Record<string, unknown>;
			const base = {
				bus: "sense" as const,
				type: event.type,
				correlationId: event.correlationId,
				payload,
				timestamp: event.timestamp,
			};
			void this.store.append({ ...base, hash: hashRecord(base) });
		});

		return () => {
			off1();
			off2();
		};
	}
}
