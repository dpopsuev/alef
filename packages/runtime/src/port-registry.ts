/**
 * PortRegistry — kernel seam cardinality validation.
 *
 * A seam is a named event channel with a declared cardinality constraint.
 * The registry validates that each loaded organ set satisfies all seam constraints
 * before the first turn.
 *
 * Cardinality:
 *   "exactly-one"  — exactly one organ must subscribe to this seam.
 *                    Missing → agent cannot respond. Multiple → race condition.
 *   "zero-or-one"  — at most one organ. Multiple → warning (undefined behaviour).
 *   "zero-or-many" — no constraint (default pub-sub).
 *
 * Seam detection: an organ covers a seam if any of its action map keys matches
 * the seam's event pattern. Wildcards in action keys (motor/*) cover all motor seams.
 *
 * EIP: PortRegistry implements the Content-Based Router pattern at boot time —
 * routing organs to seams based on their declared action map key prefixes.
 */

import type { PortCardinality, PortDefinition } from "@dpopsuev/alef-kernel";

export type { PortCardinality, PortDefinition };

export interface PortViolation {
	seam: PortDefinition;
	organCount: number;
	organNames: string[];
	severity: "error" | "warning";
	message: string;
}

export interface PortValidationResult {
	valid: boolean;
	violations: PortViolation[];
}

// ---------------------------------------------------------------------------
// Built-in seam definitions
// ---------------------------------------------------------------------------
// Organ seam membership detection
// ---------------------------------------------------------------------------

/**
 * Returns the action map keys an organ covers.
 * Organs created with defineOrgan expose their keys via the internal structure.
 * We detect coverage by inspecting the Nerve subscriptions at mount time.
 *
 * Strategy: mount the organ onto a probe nerve, record which event types it
 * subscribes to on Motor and Sense buses, then unmount.
 */
export interface OrganPortInfo {
	name: string;
	motorSubscriptions: string[]; // event types subscribed on Motor bus
	senseSubscriptions: string[]; // event types subscribed on Sense bus
}

// ---------------------------------------------------------------------------
// Seam matching
// ---------------------------------------------------------------------------

function organCoversPort(info: OrganPortInfo, seam: PortDefinition): boolean {
	const pattern = seam.eventPattern;

	if (pattern.startsWith("motor/")) {
		const eventSuffix = pattern.slice("motor/".length);
		// Wildcard subscriptions ("*") are observer patterns — they tap the bus
		// but do not own any seam. Only specific event type subscriptions cover a seam.
		return info.motorSubscriptions.some(
			(sub) =>
				sub !== "*" && // observers never cover specific seams
				(sub === eventSuffix || (eventSuffix.endsWith(".") && sub.startsWith(eventSuffix)) || eventSuffix === "*"),
		);
	}

	if (pattern.startsWith("sense/")) {
		const eventSuffix = pattern.slice("sense/".length);
		return info.senseSubscriptions.some(
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

export function validatePorts(organs: OrganPortInfo[], seams: PortDefinition[]): PortValidationResult {
	const violations: PortViolation[] = [];

	for (const seam of seams) {
		const covering = organs.filter((o) => organCoversPort(o, seam));
		const count = covering.length;
		const names = covering.map((o) => o.name);

		if (seam.cardinality === "exactly-one") {
			if (count === 0) {
				violations.push({
					seam,
					organCount: 0,
					organNames: [],
					severity: "error",
					message: `Seam '${seam.name}' (${seam.eventPattern}) requires exactly one organ but got 0. Load an organ that handles this event.`,
				});
			} else if (count > 1) {
				violations.push({
					seam,
					organCount: count,
					organNames: names,
					severity: "error",
					message: `Seam '${seam.name}' (${seam.eventPattern}) requires exactly one organ but got ${count}: [${names.join(", ")}]. Multiple organs will race.`,
				});
			}
		}

		if (seam.cardinality === "zero-or-one" && count > 1) {
			violations.push({
				seam,
				organCount: count,
				organNames: names,
				severity: "warning",
				message: `Seam '${seam.name}' (${seam.eventPattern}) expects at most one organ but got ${count}: [${names.join(", ")}]. Behaviour is undefined.`,
			});
		}
		// "ordered-pipeline": multiple organs intentional — no violation.
	}

	return {
		valid: violations.every((v) => v.severity !== "error"),
		violations,
	};
}

export class PortValidationError extends Error {
	constructor(public readonly violations: PortViolation[]) {
		const errors = violations.filter((v) => v.severity === "error");
		super(`Agent seam validation failed:\n${errors.map((v) => `  - ${v.message}`).join("\n")}`);
		this.name = "PortValidationError";
	}
}
