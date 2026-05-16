import { describe, expect, it } from "vitest";
import {
	type OrganSeamInfo,
	type SeamDefinition,
	SeamValidationError,
	STANDARD_SEAMS,
	validateSeams,
} from "../src/seam-registry.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function organ(name: string, motor: string[] = [], sense: string[] = []): OrganSeamInfo {
	return { name, motorSubscriptions: motor, senseSubscriptions: sense };
}

const PRIMARY_SEAM: SeamDefinition = {
	name: "primary_cognition",
	eventPattern: "sense/dialog.message",
	cardinality: "exactly-one",
};

const FS_SEAM: SeamDefinition = {
	name: "filesystem",
	eventPattern: "motor/fs.",
	cardinality: "zero-or-one",
};

// ---------------------------------------------------------------------------
// validateSeams — exactly-one
// ---------------------------------------------------------------------------

describe("validateSeams — exactly-one", () => {
	it("passes when exactly one organ covers the seam", () => {
		const organs = [organ("llm", [], ["dialog.message"])];
		const result = validateSeams(organs, [PRIMARY_SEAM]);
		expect(result.valid).toBe(true);
		expect(result.violations).toHaveLength(0);
	});

	it("errors when zero organs cover an exactly-one seam", () => {
		const organs = [organ("fs", ["fs.read"])];
		const result = validateSeams(organs, [PRIMARY_SEAM]);
		expect(result.valid).toBe(false);
		expect(result.violations).toHaveLength(1);
		expect(result.violations[0].severity).toBe("error");
		expect(result.violations[0].organCount).toBe(0);
		expect(result.violations[0].message).toMatch(/requires exactly one organ.*got 0/);
	});

	it("errors when two organs cover an exactly-one seam", () => {
		const organs = [organ("llm", [], ["dialog.message"]), organ("planner", [], ["dialog.message"])];
		const result = validateSeams(organs, [PRIMARY_SEAM]);
		expect(result.valid).toBe(false);
		expect(result.violations[0].organCount).toBe(2);
		expect(result.violations[0].organNames).toEqual(["llm", "planner"]);
		expect(result.violations[0].message).toMatch(/got 2/);
	});
});

// ---------------------------------------------------------------------------
// validateSeams — zero-or-one
// ---------------------------------------------------------------------------

describe("validateSeams — zero-or-one", () => {
	it("passes when zero organs cover a zero-or-one seam", () => {
		const result = validateSeams([], [FS_SEAM]);
		expect(result.valid).toBe(true);
		expect(result.violations).toHaveLength(0);
	});

	it("passes when exactly one organ covers a zero-or-one seam", () => {
		const organs = [organ("fs", ["fs.read", "fs.write"])];
		const result = validateSeams(organs, [FS_SEAM]);
		expect(result.valid).toBe(true);
	});

	it("warns (not errors) when two organs cover a zero-or-one seam", () => {
		const organs = [organ("fs1", ["fs.read"]), organ("fs2", ["fs.write"])];
		const result = validateSeams(organs, [FS_SEAM]);
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
		const result = validateSeams(organs, [PRIMARY_SEAM]);
		expect(result.valid).toBe(true);
	});

	it("matches motor prefix pattern (fs.)", () => {
		const organs = [organ("fs", ["fs.read", "fs.grep", "fs.write"])];
		const result = validateSeams(organs, [FS_SEAM]);
		expect(result.valid).toBe(true);
	});

	it("wildcard motor/* organ covers all motor seams", () => {
		const organs = [organ("evaluator", ["*"])]; // EvaluatorOrgan
		const result = validateSeams(organs, [FS_SEAM]);
		expect(result.valid).toBe(true);
	});

	it("organ on unrelated seam does not cover primary_cognition", () => {
		const organs = [organ("fs", ["fs.read"])];
		const result = validateSeams(organs, [PRIMARY_SEAM]);
		expect(result.valid).toBe(false); // no LLM = error
	});
});

// ---------------------------------------------------------------------------
// Standard seams — integration
// ---------------------------------------------------------------------------

describe("STANDARD_SEAMS — full agent stack", () => {
	it("valid: LLMOrgan on sense + FsOrgan on motor/fs.*", () => {
		const organs = [
			organ("llm", [], ["dialog.message"]),
			organ("fs", ["fs.read", "fs.grep", "fs.find", "fs.write", "fs.edit"]),
			organ("shell", ["shell.exec"]),
		];
		const result = validateSeams(organs, STANDARD_SEAMS);
		expect(result.valid).toBe(true);
		expect(result.violations).toHaveLength(0);
	});

	it("error: no reasoning organ loaded", () => {
		const organs = [organ("fs", ["fs.read"])];
		const result = validateSeams(organs, STANDARD_SEAMS);
		expect(result.valid).toBe(false);
		const err = result.violations.find((v) => v.seam.name === "primary_cognition");
		expect(err?.severity).toBe("error");
	});

	it("error: two LLMOrgans loaded (race condition)", () => {
		const organs = [organ("llm", [], ["dialog.message"]), organ("mock-llm", [], ["dialog.message"])];
		const result = validateSeams(organs, STANDARD_SEAMS);
		expect(result.valid).toBe(false);
		expect(result.violations[0].organNames).toContain("llm");
		expect(result.violations[0].organNames).toContain("mock-llm");
	});
});

// ---------------------------------------------------------------------------
// SeamValidationError
// ---------------------------------------------------------------------------

describe("SeamValidationError", () => {
	it("is an Error with a descriptive message", () => {
		const organs: OrganSeamInfo[] = [];
		const result = validateSeams(organs, [PRIMARY_SEAM]);
		const errors = result.violations.filter((v) => v.severity === "error");
		const err = new SeamValidationError(errors);
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe("SeamValidationError");
		expect(err.message).toMatch(/seam validation failed/i);
		expect(err.message).toMatch(/primary_cognition/);
	});
});
