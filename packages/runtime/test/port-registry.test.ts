import { describe, expect, it } from "vitest";
import {
	type OrganPortInfo,
	type PortDefinition,
	PortValidationError,
	STANDARD_PORTS,
	validatePorts,
} from "../src/port-registry.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function organ(name: string, motor: string[] = [], sense: string[] = []): OrganPortInfo {
	return { name, motorSubscriptions: motor, senseSubscriptions: sense };
}

const PRIMARY_SEAM: PortDefinition = {
	name: "reasoning",
	eventPattern: "sense/llm.input",
	cardinality: "exactly-one",
};

const FS_SEAM: PortDefinition = {
	name: "filesystem",
	eventPattern: "motor/fs.",
	cardinality: "zero-or-one",
};

// ---------------------------------------------------------------------------
// validatePorts — exactly-one
// ---------------------------------------------------------------------------

describe("validatePorts — exactly-one", { tags: ["unit"] }, () => {
	it("passes when exactly one organ covers the seam", () => {
		const organs = [organ("llm", [], ["llm.input"])];
		const result = validatePorts(organs, [PRIMARY_SEAM]);
		expect(result.valid).toBe(true);
		expect(result.violations).toHaveLength(0);
	});

	it("errors when zero organs cover an exactly-one seam", () => {
		const organs = [organ("fs", ["fs.read"])];
		const result = validatePorts(organs, [PRIMARY_SEAM]);
		expect(result.valid).toBe(false);
		expect(result.violations).toHaveLength(1);
		expect(result.violations[0].severity).toBe("error");
		expect(result.violations[0].organCount).toBe(0);
		expect(result.violations[0].message).toMatch(/requires exactly one organ.*got 0/);
	});

	it("errors when two organs cover an exactly-one seam", () => {
		const organs = [organ("llm", [], ["llm.input"]), organ("planner", [], ["llm.input"])];
		const result = validatePorts(organs, [PRIMARY_SEAM]);
		expect(result.valid).toBe(false);
		expect(result.violations[0].organCount).toBe(2);
		expect(result.violations[0].organNames).toEqual(["llm", "planner"]);
		expect(result.violations[0].message).toMatch(/got 2/);
	});
});

// ---------------------------------------------------------------------------
// validatePorts — zero-or-one
// ---------------------------------------------------------------------------

describe("validatePorts — zero-or-one", { tags: ["unit"] }, () => {
	it("passes when zero organs cover a zero-or-one seam", () => {
		const result = validatePorts([], [FS_SEAM]);
		expect(result.valid).toBe(true);
		expect(result.violations).toHaveLength(0);
	});

	it("passes when exactly one organ covers a zero-or-one seam", () => {
		const organs = [organ("fs", ["fs.read", "fs.write"])];
		const result = validatePorts(organs, [FS_SEAM]);
		expect(result.valid).toBe(true);
	});

	it("warns (not errors) when two organs cover a zero-or-one seam", () => {
		const organs = [organ("fs1", ["fs.read"]), organ("fs2", ["fs.write"])];
		const result = validatePorts(organs, [FS_SEAM]);
		expect(result.valid).toBe(true); // warning, not error
		expect(result.violations[0].severity).toBe("warning");
		expect(result.violations[0].organCount).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// Seam pattern matching
// ---------------------------------------------------------------------------

describe("seam pattern matching", { tags: ["unit"] }, () => {
	it("matches exact sense event type", () => {
		const organs = [organ("llm", [], ["llm.input"])];
		const result = validatePorts(organs, [PRIMARY_SEAM]);
		expect(result.valid).toBe(true);
	});

	it("matches motor prefix pattern (fs.)", () => {
		const organs = [organ("fs", ["fs.read", "fs.grep", "fs.write"])];
		const result = validatePorts(organs, [FS_SEAM]);
		expect(result.valid).toBe(true);
	});

	it("wildcard motor/* organ covers all motor seams", () => {
		const organs = [organ("evaluator", ["*"])]; // EvaluatorOrgan
		const result = validatePorts(organs, [FS_SEAM]);
		expect(result.valid).toBe(true);
	});

	it("organ on unrelated seam does not cover reasoning", () => {
		const organs = [organ("fs", ["fs.read"])];
		const result = validatePorts(organs, [PRIMARY_SEAM]);
		expect(result.valid).toBe(false); // no LLM = error
	});
});

// ---------------------------------------------------------------------------
// Standard seams — integration
// ---------------------------------------------------------------------------

describe("STANDARD_PORTS — full agent stack", { tags: ["unit"] }, () => {
	it("valid: Reasoner on sense + FsOrgan on motor/fs.*", () => {
		const organs = [
			organ("llm", [], ["llm.input"]),
			organ("fs", ["fs.read", "fs.grep", "fs.find", "fs.write", "fs.edit"]),
			organ("shell", ["shell.exec"]),
		];
		const result = validatePorts(organs, STANDARD_PORTS);
		expect(result.valid).toBe(true);
		expect(result.violations).toHaveLength(0);
	});

	it("valid: no reasoning organ loaded — autonomous agents have no dialog trigger", () => {
		// The 'reasoning' seam was removed from STANDARD_PORTS. An agent with no
		// dialog trigger is valid — it waits for external events (git.push, cron.tick, etc.)
		const organs = [organ("fs", ["fs.read"])];
		const result = validatePorts(organs, STANDARD_PORTS);
		expect(result.valid).toBe(true);
	});

	it("valid: two organs handling the same sense event — no race constraint on triggers", () => {
		// Without the 'reasoning' exactly-one constraint, multiple trigger organs are allowed.
		// The agent author is responsible for ensuring only one fires per event.
		const organs = [organ("llm", [], ["llm.input"]), organ("mock-llm", [], ["llm.input"])];
		const result = validatePorts(organs, STANDARD_PORTS);
		expect(result.valid).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// PortValidationError
// ---------------------------------------------------------------------------

describe("PortValidationError", { tags: ["unit"] }, () => {
	it("is an Error with a descriptive message", () => {
		const organs: OrganPortInfo[] = [];
		const result = validatePorts(organs, [PRIMARY_SEAM]);
		const errors = result.violations.filter((v) => v.severity === "error");
		const err = new PortValidationError(errors);
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe("PortValidationError");
		expect(err.message).toMatch(/seam validation failed/i);
		expect(err.message).toMatch(/reasoning/);
	});

	// ---------------------------------------------------------------------------
	// context_observer seam pattern "sense/*" matches ANY sense subscription via
	// the eventSuffix === "*" branch in organCoversPort. Skills subscribes to
	// sense/organ.loaded and sense/organ.unloaded (lifecycle events). Both llm
	// and skills match sense/*, triggering a zero-or-one violation even though
	// they handle completely different events with no conflict.
	//
	// Fix: narrow context_observer to "sense/dialog." and add a lifecycle seam
	// "sense/organ." with zero-or-many cardinality.
	// ---------------------------------------------------------------------------

	describe("STANDARD_PORTS — context_observer false-positive with lifecycle organs", { tags: ["unit"] }, () => {
		it("llm + skills organs subscribing to different sense events must not trigger context_observer warning", () => {
			const llmOrgan = organ("llm", [], ["llm.input"]);
			const skillsOrgan = organ("skills", [], ["organ.loaded", "organ.unloaded"]);

			const result = validatePorts([llmOrgan, skillsOrgan], STANDARD_PORTS);

			const contextViolation = result.violations.find(
				(v) => v.seam.name === "context_observer" && v.organNames.includes("skills"),
			);
			expect(
				contextViolation,
				"skills subscribing to lifecycle sense events must not trigger context_observer cardinality warning — they are not reasoning organs",
			).toBeUndefined();
		});

		it("context_observer seam must match the reasoning trigger specifically, not all sense subscriptions", () => {
			const contextSeam = STANDARD_PORTS.find((s) => s.name === "context_observer");
			expect(contextSeam, "context_observer seam must exist").toBeDefined();
			expect(
				contextSeam?.eventPattern,
				"context_observer must not use 'sense/*' wildcard — it incorrectly matches lifecycle organs",
			).not.toBe("sense/*");
		});
	});
});
