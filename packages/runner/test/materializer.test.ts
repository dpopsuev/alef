import { compileAgentDefinition } from "@dpopsuev/alef-agent-blueprint";
import { describe, expect, it } from "vitest";
import { materializeBlueprint } from "../src/materializer.js";

const CWD = "/tmp/test-workspace";

function makeDefinition(organs: { name: string; actions?: string[] }[]) {
	return compileAgentDefinition({
		name: "test-agent",
		organs: organs.map((o) => ({
			name: o.name as "fs" | "shell",
			actions: o.actions,
		})),
	});
}

describe("materializeBlueprint", () => {
	it("returns empty organ list when no organs declared", () => {
		const def = compileAgentDefinition({ name: "empty" });
		const result = materializeBlueprint(def, { cwd: CWD });
		expect(result.organs).toHaveLength(0);
		expect(result.modelId).toBeUndefined();
	});

	it("instantiates FsOrgan for fs organ", () => {
		const def = makeDefinition([{ name: "fs" }]);
		const result = materializeBlueprint(def, { cwd: CWD });
		expect(result.organs).toHaveLength(1);
		expect(result.organs[0].name).toBe("fs");
	});

	it("instantiates ShellOrgan for shell organ", () => {
		const def = makeDefinition([{ name: "shell" }]);
		const result = materializeBlueprint(def, { cwd: CWD });
		expect(result.organs).toHaveLength(1);
		expect(result.organs[0].name).toBe("shell");
	});

	it("instantiates both fs and shell", () => {
		const def = makeDefinition([{ name: "fs" }, { name: "shell" }]);
		const result = materializeBlueprint(def, { cwd: CWD });
		expect(result.organs).toHaveLength(2);
		expect(result.organs.map((o) => o.name)).toEqual(["fs", "shell"]);
	});

	it("lector organ is now supported in the EDA runtime", () => {
		const def = compileAgentDefinition({
			name: "lector-agent",
			organs: [{ name: "lector" }],
		});
		const result = materializeBlueprint(def, { cwd: CWD });
		expect(result.organs).toHaveLength(1);
		expect(result.organs[0].name).toBe("lector");
	});

	it("skips truly unsupported organs (symbols) without throwing", () => {
		const def = compileAgentDefinition({
			name: "advanced",
			organs: [{ name: "fs" }, { name: "symbols" }],
		});
		const result = materializeBlueprint(def, { cwd: CWD });
		expect(result.organs).toHaveLength(1);
		expect(result.organs[0].name).toBe("fs");
	});

	it("returns modelId from blueprint model field", () => {
		const def = compileAgentDefinition({
			name: "model-agent",
			model: "anthropic/claude-opus-4-5",
		});
		const result = materializeBlueprint(def, { cwd: CWD });
		expect(result.modelId).toBe("anthropic/claude-opus-4-5");
	});

	it("returns undefined modelId when blueprint has no model", () => {
		const def = compileAgentDefinition({ name: "no-model" });
		const result = materializeBlueprint(def, { cwd: CWD });
		expect(result.modelId).toBeUndefined();
	});

	it("respects action allowlist on fs organ", () => {
		const def = makeDefinition([{ name: "fs", actions: ["read"] }]);
		const result = materializeBlueprint(def, { cwd: CWD });
		expect(result.organs).toHaveLength(1);
		// FsOrgan with read-only actions — only fs.read tool exposed
		const organ = result.organs[0];
		expect(organ.tools.some((t) => t.name === "fs.read")).toBe(true);
		expect(organ.tools.some((t) => t.name === "fs.write")).toBe(false);
	});
});
