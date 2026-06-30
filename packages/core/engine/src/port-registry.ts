/**
 * PortRegistry — kernel seam cardinality validation.
 *
 * A seam is a named event channel with a declared cardinality constraint.
 * The registry validates that each loaded adapter set satisfies all seam constraints
 * before the first turn.
 *
 * Cardinality:
 *   "exactly-one"  — exactly one adapter must subscribe to this seam.
 *                    Missing → agent cannot respond. Multiple → race condition.
 *   "zero-or-one"  — at most one adapter. Multiple → warning (undefined behaviour).
 *   "zero-or-many" — no constraint (default pub-sub).
 *
 * Seam detection: an adapter covers a seam if any of its action map keys matches
 * the seam's event pattern. Wildcards in action keys (command/*) cover all command seams.
 *
 * EIP: PortRegistry implements the Content-Based Router pattern at boot time —
 * routing adapters to seams based on their declared action map key prefixes.
 */

import type { PortCardinality, PortDefinition } from "@dpopsuev/alef-kernel/adapter";

export type { PortCardinality, PortDefinition };

/** A single cardinality constraint violation detected during port validation. */
export interface PortViolation {
	seam: PortDefinition;
	adapterCount: number;
	adapterNames: string[];
	severity: "error" | "warning";
	message: string;
}

/** Aggregate result of port cardinality validation across all loaded adapters. */
export interface PortValidationResult {
	valid: boolean;
	violations: PortViolation[];
}

// ---------------------------------------------------------------------------
// Built-in seam definitions
// ---------------------------------------------------------------------------
// Adapter seam membership detection
// ---------------------------------------------------------------------------

/**
 * Returns the action map keys an adapter covers.
 * Adapters created with defineAdapter expose their keys via the internal structure.
 * We detect coverage by inspecting the Bus subscriptions at mount time.
 *
 * Strategy: mount the adapter onto a probe bus, record which event types it
 * subscribes to on Command and Event buses, then unmount.
 */
export interface AdapterPortInfo {
	name: string;
	commandSubscriptions: string[]; // event types subscribed on Command bus
	eventSubscriptions: string[]; // event types subscribed on Event bus
}

// ---------------------------------------------------------------------------
// Seam matching
// ---------------------------------------------------------------------------

/** Return whether an adapter's subscriptions match the event pattern of a port seam. */
function adapterCoversPort(info: AdapterPortInfo, seam: PortDefinition): boolean {
	const pattern = seam.eventPattern;

	if (pattern.startsWith("command/")) {
		const eventSuffix = pattern.slice("command/".length);
		// Wildcard subscriptions ("*") are observer patterns — they tap the bus
		// but do not own any seam. Only specific event type subscriptions cover a seam.
		return info.commandSubscriptions.some(
			(sub) =>
				sub !== "*" && // observers never cover specific seams
				(sub === eventSuffix || (eventSuffix.endsWith(".") && sub.startsWith(eventSuffix)) || eventSuffix === "*"),
		);
	}

	if (pattern.startsWith("event/")) {
		const eventSuffix = pattern.slice("event/".length);
		return info.eventSubscriptions.some(
			(sub) =>
				sub !== "*" && // observers never cover specific seams
				(sub === eventSuffix || (eventSuffix.endsWith(".") && sub.startsWith(eventSuffix)) || eventSuffix === "*"),
		);
	}

	return false;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Check that every declared port seam is covered by the correct number of adapters. */
export function validatePorts(adapters: AdapterPortInfo[], seams: PortDefinition[]): PortValidationResult {
	const violations: PortViolation[] = [];

	for (const seam of seams) {
		const covering = adapters.filter((o) => adapterCoversPort(o, seam));
		const count = covering.length;
		const names = covering.map((o) => o.name);

		if (seam.cardinality === "exactly-one") {
			if (count === 0) {
				violations.push({
					seam,
					adapterCount: 0,
					adapterNames: [],
					severity: "error",
					message: `Seam '${seam.name}' (${seam.eventPattern}) requires exactly one adapter but got 0. Load an adapter that handles this event.`,
				});
			} else if (count > 1) {
				violations.push({
					seam,
					adapterCount: count,
					adapterNames: names,
					severity: "error",
					message: `Seam '${seam.name}' (${seam.eventPattern}) requires exactly one adapter but got ${count}: [${names.join(", ")}]. Multiple adapters will race.`,
				});
			}
		}

		if (seam.cardinality === "zero-or-one" && count > 1) {
			violations.push({
				seam,
				adapterCount: count,
				adapterNames: names,
				severity: "warning",
				message: `Seam '${seam.name}' (${seam.eventPattern}) expects at most one adapter but got ${count}: [${names.join(", ")}]. Behaviour is undefined.`,
			});
		}
		// "ordered-pipeline": multiple adapters intentional — no violation.
	}

	return {
		valid: violations.every((v) => v.severity !== "error"),
		violations,
	};
}

/** Thrown when exactly-one port constraints are violated at agent validation time. */
export class PortValidationError extends Error {
	constructor(public readonly violations: PortViolation[]) {
		const errors = violations.filter((v) => v.severity === "error");
		super(`Agent seam validation failed:\n${errors.map((v) => `  - ${v.message}`).join("\n")}`);
		this.name = "PortValidationError";
	}
}
