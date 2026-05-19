/**
 * ReactorOrgan — cross-turn in-flight operation tracking.
 *
 * Subscribes motor/* and sense/* as wildcard observers.
 * Every motor event (except dialog.message) is recorded as in-flight.
 * When the matching sense event arrives (same type + correlationId + toolCallId),
 * the entry is removed.
 *
 * prepareStep: if the in-flight map is non-empty, appends a pending-operations
 * block to the system message before the LLM call. The LLM can then reason
 * about what other turns are currently doing.
 *
 * In sequential (interactive) mode the map is always empty at prepareStep time
 * — zero overhead, messages returned unchanged.
 * In concurrent (HTTP/SSE) mode the map shows cross-turn in-flight state.
 */

import type { MotorEvent, Nerve, Organ, SenseEvent } from "@dpopsuev/alef-spine";

export interface InFlightEntry {
	type: string;
	correlationId: string;
	toolCallId: string | undefined;
	args: Record<string, unknown>;
	startedAt: number;
}

const EXCLUDED_MOTOR_TYPES = new Set(["dialog.message"]);

/** Key that uniquely identifies a tool call in the in-flight map. */
function entryKey(type: string, correlationId: string, toolCallId: string | undefined): string {
	return `${type}::${correlationId}::${toolCallId ?? ""}`;
}

/** Extract the most informative single arg from a payload for display. */
function keyArg(_type: string, payload: Record<string, unknown>): string {
	// Prefer domain-specific args in order of usefulness.
	for (const key of ["command", "path", "url", "pattern", "glob", "symbol", "query"]) {
		const v = payload[key];
		if (typeof v === "string" && v.length > 0) return v.slice(0, 80);
	}
	const entries = Object.entries(payload).filter(([k]) => k !== "toolCallId");
	if (entries.length === 0) return "";
	const [k, v] = entries[0];
	return `${k}=${String(v).slice(0, 60)}`;
}

export type PrepareStep<T> = (messages: T[]) => T[] | Promise<T[]>;

export interface ReactorOrgan extends Organ {
	/** Current in-flight entries keyed by entryKey. */
	inflight(): Map<string, InFlightEntry>;
	/**
	 * prepareStep function to pass to LLMOrgan.options.prepareStep.
	 * Appends a pending-operations block to the system message when the
	 * in-flight map is non-empty. Returns messages unchanged otherwise.
	 */
	prepareStep<T extends { role: string; content: string }>(messages: T[]): T[] | Promise<T[]>;
}

export function createReactorOrgan(): ReactorOrgan {
	const map = new Map<string, InFlightEntry>();

	function onMotor(event: MotorEvent): void {
		if (EXCLUDED_MOTOR_TYPES.has(event.type)) return;
		const toolCallId = typeof event.payload.toolCallId === "string" ? event.payload.toolCallId : undefined;
		const key = entryKey(event.type, event.correlationId, toolCallId);
		map.set(key, {
			type: event.type,
			correlationId: event.correlationId,
			toolCallId,
			args: event.payload,
			startedAt: event.timestamp,
		});
	}

	function onSense(event: SenseEvent): void {
		const toolCallId = typeof event.payload.toolCallId === "string" ? event.payload.toolCallId : undefined;
		const key = entryKey(event.type, event.correlationId, toolCallId);
		map.delete(key);
	}

	return {
		name: "reactor",
		tools: [] as const,
		subscriptions: { motor: ["*"] as const, sense: ["*"] as const },

		mount(nerve: Nerve): () => void {
			const off1 = nerve.motor.subscribe("*", onMotor);
			const off2 = nerve.sense.subscribe("*", onSense);
			return () => {
				off1();
				off2();
				map.clear();
			};
		},

		inflight() {
			return new Map(map);
		},

		prepareStep<T extends { role: string; content: string }>(messages: T[]): T[] {
			if (map.size === 0) return messages;

			const now = Date.now();
			const lines = [...map.values()].map((e) => {
				const elapsedSec = Math.floor((now - e.startedAt) / 1000);
				const corrShort = e.correlationId.slice(0, 8);
				const arg = keyArg(e.type, e.args);
				return `  - ${e.type} (${corrShort}, ${elapsedSec}s)${arg ? `: ${arg}` : ""}`;
			});
			const block = `\nPending operations:\n${lines.join("\n")}`;

			const sysIdx = messages.findIndex((m) => m.role === "system");
			if (sysIdx >= 0) {
				const updated = [...messages] as T[];
				updated[sysIdx] = { ...messages[sysIdx], content: messages[sysIdx].content + block };
				return updated;
			}

			// No system message — prepend one.
			return [{ role: "system", content: block.trimStart() } as unknown as T, ...messages];
		},
	};
}
