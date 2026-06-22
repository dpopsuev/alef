import { describe, expect, it } from "vitest";
import { type OrganPortInfo, type PortDefinition, PortValidationError, validatePorts } from "../src/port-registry.js";

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
		expect(result.violations[0].adapterCount).toBe(0);
		expect(result.violations[0].message).toMatch(/requires exactly one organ.*got 0/);
	});

	it("errors when two organs cover an exactly-one seam", () => {
		const organs = [organ("llm", [], ["llm.input"]), organ("planner", [], ["llm.input"])];
		const result = validatePorts(organs, [PRIMARY_SEAM]);
		expect(result.valid).toBe(false);
		expect(result.violations[0].adapterCount).toBe(2);
		expect(result.violations[0].adapterNames).toEqual(["llm", "planner"]);
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
		expect(result.violations[0].adapterCount).toBe(2);
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

	it("wildcard motor/* organ does not cover specific seams", () => {
		const organs = [organ("evaluator", ["*"])];
		const result = validatePorts(organs, [FS_SEAM]);
		expect(result.valid).toBe(true);
	});

	it("organ on unrelated seam does not cover reasoning", () => {
		const organs = [organ("fs", ["fs.read"])];
		const result = validatePorts(organs, [PRIMARY_SEAM]);
		expect(result.valid).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Dynamic port collection — contributions["port"]
// ---------------------------------------------------------------------------

describe("dynamic port collection", { tags: ["unit"] }, () => {
	it("validates ports declared by organ contributions", () => {
		const organs = [organ("llm", [], ["llm.input"]), organ("fs", ["fs.read"])];
		const ports: PortDefinition[] = [
			{ name: "reasoning", eventPattern: "sense/llm.input", cardinality: "exactly-one" },
			{ name: "filesystem", eventPattern: "motor/fs.", cardinality: "zero-or-one" },
		];
		const result = validatePorts(organs, ports);
		expect(result.valid).toBe(true);
		expect(result.violations).toHaveLength(0);
	});

	it("empty port list passes with no constraints", () => {
		const result = validatePorts([organ("fs", ["fs.read"])], []);
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
});
