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
	eventPattern: "sense/dialog.message",
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

describe("validatePorts — exactly-one", () => {
	it("passes when exactly one organ covers the seam", () => {
		const organs = [organ("llm", [], ["dialog.message"])];
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
		const organs = [organ("llm", [], ["dialog.message"]), organ("planner", [], ["dialog.message"])];
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

describe("validatePorts — zero-or-one", () => {
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

describe("seam pattern matching", () => {
	it("matches exact sense event type", () => {
		const organs = [organ("llm", [], ["dialog.message"])];
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

describe("STANDARD_PORTS — full agent stack", () => {
	it("valid: LLMOrgan on sense + FsOrgan on motor/fs.*", () => {
		const organs = [
			organ("llm", [], ["dialog.message"]),
			organ("fs", ["fs.read", "fs.grep", "fs.find", "fs.write", "fs.edit"]),
			organ("shell", ["shell.exec"]),
		];
		const result = validatePorts(organs, STANDARD_PORTS);
		expect(result.valid).toBe(true);
		expect(result.violations).toHaveLength(0);
	});

	it("error: no reasoning organ loaded", () => {
		const organs = [organ("fs", ["fs.read"])];
		const result = validatePorts(organs, STANDARD_PORTS);
		expect(result.valid).toBe(false);
		const err = result.violations.find((v) => v.seam.name === "reasoning");
		expect(err?.severity).toBe("error");
	});

	it("error: two LLMOrgans loaded (race condition)", () => {
		const organs = [organ("llm", [], ["dialog.message"]), organ("mock-llm", [], ["dialog.message"])];
		const result = validatePorts(organs, STANDARD_PORTS);
		expect(result.valid).toBe(false);
		expect(result.violations[0].organNames).toContain("llm");
		expect(result.violations[0].organNames).toContain("mock-llm");
	});
});

// ---------------------------------------------------------------------------
// PortValidationError
// ---------------------------------------------------------------------------

describe("PortValidationError", () => {
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
});
