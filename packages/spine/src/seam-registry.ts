/**
 * SeamRegistry — kernel seam cardinality validation.
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
 * EIP: SeamRegistry implements the Content-Based Router pattern at boot time —
 * routing organs to seams based on their declared action map key prefixes.
 */

export type SeamCardinality = "exactly-one" | "zero-or-one" | "zero-or-many";

export interface SeamDefinition {
	/** Human-readable name. */
	name: string;
	/**
	 * Event pattern this seam covers.
	 * Matches action map keys: "motor/dialog.message", "sense/dialog.message".
	 * Use "*" suffix for wildcard: "motor/*" matches any motor action.
	 */
	eventPattern: string;
	cardinality: SeamCardinality;
}

export interface SeamViolation {
	seam: SeamDefinition;
	organCount: number;
	organNames: string[];
	severity: "error" | "warning";
	message: string;
}

export interface SeamValidationResult {
	valid: boolean;
	violations: SeamViolation[];
}

// ---------------------------------------------------------------------------
// Built-in seam definitions
// ---------------------------------------------------------------------------

/**
 * The canonical seam registry for the standard Alef agent.
 * Override or extend for custom agent topologies.
 */
export const STANDARD_SEAMS: SeamDefinition[] = [
	{
		name: "primary_cognition",
		eventPattern: "sense/dialog.message",
		cardinality: "exactly-one",
	},
	{
		name: "llm_execution",
		eventPattern: "motor/llm.phase",
		cardinality: "zero-or-one",
	},
	{
		name: "filesystem",
		eventPattern: "motor/fs.",
		cardinality: "zero-or-one",
	},
	{
		name: "shell",
		eventPattern: "motor/shell.",
		cardinality: "zero-or-one",
	},
	{
		name: "web",
		eventPattern: "motor/web.",
		cardinality: "zero-or-one",
	},
	{
		name: "enclosure",
		eventPattern: "motor/enclosure.",
		cardinality: "zero-or-one",
	},
	{
		name: "context_observer",
		eventPattern: "sense/*",
		cardinality: "zero-or-one",
	},
];

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
export interface OrganSeamInfo {
	name: string;
	motorSubscriptions: string[]; // event types subscribed on Motor bus
	senseSubscriptions: string[]; // event types subscribed on Sense bus
}

// ---------------------------------------------------------------------------
// Seam matching
// ---------------------------------------------------------------------------

function organCoverSeam(info: OrganSeamInfo, seam: SeamDefinition): boolean {
	const pattern = seam.eventPattern;

	if (pattern.startsWith("motor/")) {
		const eventSuffix = pattern.slice("motor/".length);
		return info.motorSubscriptions.some(
			(sub) =>
				sub === "*" || // wildcard organ covers all motor seams
				sub === eventSuffix ||
				(eventSuffix.endsWith(".") && sub.startsWith(eventSuffix)) ||
				eventSuffix === "*",
		);
	}

	if (pattern.startsWith("sense/")) {
		const eventSuffix = pattern.slice("sense/".length);
		return info.senseSubscriptions.some(
			(sub) =>
				sub === "*" ||
				sub === eventSuffix ||
				(eventSuffix.endsWith(".") && sub.startsWith(eventSuffix)) ||
				eventSuffix === "*",
		);
	}

	return false;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateSeams(organs: OrganSeamInfo[], seams: SeamDefinition[] = STANDARD_SEAMS): SeamValidationResult {
	const violations: SeamViolation[] = [];

	for (const seam of seams) {
		const covering = organs.filter((o) => organCoverSeam(o, seam));
		const count = covering.length;
		const names = covering.map((o) => o.name);

		if (seam.cardinality === "exactly-one") {
			if (count === 0) {
				violations.push({
					seam,
					organCount: 0,
					organNames: [],
					severity: "error",
					message: `Seam '${seam.name}' (${seam.eventPattern}) requires exactly one organ but got 0. The agent cannot respond to dialog messages.`,
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
	}

	return {
		valid: violations.every((v) => v.severity !== "error"),
		violations,
	};
}

export class SeamValidationError extends Error {
	constructor(public readonly violations: SeamViolation[]) {
		const errors = violations.filter((v) => v.severity === "error");
		super(`Agent seam validation failed:\n${errors.map((v) => `  - ${v.message}`).join("\n")}`);
		this.name = "SeamValidationError";
	}
}
