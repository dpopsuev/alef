import { describe, expect, it } from "vitest";
import { type AdapterPortInfo, type PortDefinition, PortValidationError, validatePorts } from "../src/port-registry.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function adapter(name: string, command: string[] = [], event: string[] = []): AdapterPortInfo {
	return { name, commandSubscriptions: command, eventSubscriptions: event };
}

const PRIMARY_SEAM: PortDefinition = {
	name: "reasoning",
	eventPattern: "event/llm.input",
	cardinality: "exactly-one",
};

const FS_SEAM: PortDefinition = {
	name: "filesystem",
	eventPattern: "command/fs.",
	cardinality: "zero-or-one",
};

// ---------------------------------------------------------------------------
// validatePorts — exactly-one
// ---------------------------------------------------------------------------

describe("validatePorts — exactly-one", { tags: ["unit"] }, () => {
	it("passes when exactly one adapter covers the seam", () => {
		const adapters = [adapter("llm", [], ["llm.input"])];
		const result = validatePorts(adapters, [PRIMARY_SEAM]);
		expect(result.valid).toBe(true);
		expect(result.violations).toHaveLength(0);
	});

	it("errors when zero adapters cover an exactly-one seam", () => {
		const adapters = [adapter("fs", ["fs.read"])];
		const result = validatePorts(adapters, [PRIMARY_SEAM]);
		expect(result.valid).toBe(false);
		expect(result.violations).toHaveLength(1);
		expect(result.violations[0]!.severity).toBe("error");
		expect(result.violations[0]!.adapterCount).toBe(0);
		expect(result.violations[0]!.message).toMatch(/requires exactly one adapter.*got 0/);
	});

	it("errors when two adapters cover an exactly-one seam", () => {
		const adapters = [adapter("llm", [], ["llm.input"]), adapter("planner", [], ["llm.input"])];
		const result = validatePorts(adapters, [PRIMARY_SEAM]);
		expect(result.valid).toBe(false);
		expect(result.violations[0]!.adapterCount).toBe(2);
		expect(result.violations[0]!.adapterNames).toEqual(["llm", "planner"]);
		expect(result.violations[0]!.message).toMatch(/got 2/);
	});
});

// ---------------------------------------------------------------------------
// validatePorts — zero-or-one
// ---------------------------------------------------------------------------

describe("validatePorts — zero-or-one", { tags: ["unit"] }, () => {
	it("passes when zero adapters cover a zero-or-one seam", () => {
		const result = validatePorts([], [FS_SEAM]);
		expect(result.valid).toBe(true);
		expect(result.violations).toHaveLength(0);
	});

	it("passes when exactly one adapter covers a zero-or-one seam", () => {
		const adapters = [adapter("fs", ["fs.read", "fs.write"])];
		const result = validatePorts(adapters, [FS_SEAM]);
		expect(result.valid).toBe(true);
	});

	it("warns (not errors) when two adapters cover a zero-or-one seam", () => {
		const adapters = [adapter("fs1", ["fs.read"]), adapter("fs2", ["fs.write"])];
		const result = validatePorts(adapters, [FS_SEAM]);
		expect(result.valid).toBe(true); // warning, not error
		expect(result.violations[0]!.severity).toBe("warning");
		expect(result.violations[0]!.adapterCount).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// Seam pattern matching
// ---------------------------------------------------------------------------

describe("seam pattern matching", { tags: ["unit"] }, () => {
	it("matches exact event event type", () => {
		const adapters = [adapter("llm", [], ["llm.input"])];
		const result = validatePorts(adapters, [PRIMARY_SEAM]);
		expect(result.valid).toBe(true);
	});

	it("matches command prefix pattern (fs.)", () => {
		const adapters = [adapter("fs", ["fs.read", "fs.grep", "fs.write"])];
		const result = validatePorts(adapters, [FS_SEAM]);
		expect(result.valid).toBe(true);
	});

	it("wildcard command/* adapter does not cover specific seams", () => {
		const adapters = [adapter("evaluator", ["*"])];
		const result = validatePorts(adapters, [FS_SEAM]);
		expect(result.valid).toBe(true);
	});

	it("adapter on unrelated seam does not cover reasoning", () => {
		const adapters = [adapter("fs", ["fs.read"])];
		const result = validatePorts(adapters, [PRIMARY_SEAM]);
		expect(result.valid).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Dynamic port collection — contributions["port"]
// ---------------------------------------------------------------------------

describe("dynamic port collection", { tags: ["unit"] }, () => {
	it("validates ports declared by adapter contributions", () => {
		const adapters = [adapter("llm", [], ["llm.input"]), adapter("fs", ["fs.read"])];
		const ports: PortDefinition[] = [
			{ name: "reasoning", eventPattern: "event/llm.input", cardinality: "exactly-one" },
			{ name: "filesystem", eventPattern: "command/fs.", cardinality: "zero-or-one" },
		];
		const result = validatePorts(adapters, ports);
		expect(result.valid).toBe(true);
		expect(result.violations).toHaveLength(0);
	});

	it("empty port list passes with no constraints", () => {
		const result = validatePorts([adapter("fs", ["fs.read"])], []);
		expect(result.valid).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// PortValidationError
// ---------------------------------------------------------------------------

describe("PortValidationError", { tags: ["unit"] }, () => {
	it("is an Error with a descriptive message", () => {
		const adapters: AdapterPortInfo[] = [];
		const result = validatePorts(adapters, [PRIMARY_SEAM]);
		const errors = result.violations.filter((v) => v.severity === "error");
		const err = new PortValidationError(errors);
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe("PortValidationError");
		expect(err.message).toMatch(/seam validation failed/i);
		expect(err.message).toMatch(/reasoning/);
	});
});
