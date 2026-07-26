import { describe, expect, it } from "vitest";
import { compileBlueprintArtifact, computeArtifactHash, type ResolvedPackageIdentity } from "../src/artifact.js";
import { compileAgentDefinition } from "../src/blueprints.js";

const FS_PACKAGE: ResolvedPackageIdentity = {
	adapter: "fs",
	package: "@dpopsuev/alef-tool-fs",
	version: "1.2.3",
	vendor: "dpopsuev",
};

function baseContext() {
	return {
		packages: [FS_PACKAGE],
		commandOwnership: { "fs.read": "fs", "fs.write": "fs" },
		writableRoots: ["/workspace"],
	};
}

describe("compileBlueprintArtifact", () => {
	it("is reproducible: same definition and context hash identically", () => {
		const definition = compileAgentDefinition({ name: "agent", adapters: [{ name: "fs" }] });
		const first = compileBlueprintArtifact(definition, baseContext());
		const second = compileBlueprintArtifact(definition, baseContext());
		expect(first.artifactHash).toBe(second.artifactHash);
		expect(first.artifactHash).toMatch(/^[0-9a-f]{64}$/);
	});

	it("changes hash when a resolved package version changes", () => {
		const definition = compileAgentDefinition({ name: "agent", adapters: [{ name: "fs" }] });
		const first = compileBlueprintArtifact(definition, baseContext());
		const second = compileBlueprintArtifact(definition, {
			...baseContext(),
			packages: [{ ...FS_PACKAGE, version: "1.2.4" }],
		});
		expect(first.artifactHash).not.toBe(second.artifactHash);
	});

	it("changes hash when permissions (writableRoots) differ", () => {
		const definition = compileAgentDefinition({ name: "agent", adapters: [{ name: "fs" }] });
		const first = compileBlueprintArtifact(definition, baseContext());
		const second = compileBlueprintArtifact(definition, { ...baseContext(), writableRoots: ["/other"] });
		expect(first.artifactHash).not.toBe(second.artifactHash);
	});

	it("changes hash when budgets differ", () => {
		const withBudget = compileAgentDefinition({
			name: "agent",
			adapters: [{ name: "fs" }],
			budget: { maxToolCalls: 10 },
		});
		const withoutBudget = compileAgentDefinition({ name: "agent", adapters: [{ name: "fs" }] });
		const first = compileBlueprintArtifact(withBudget, baseContext());
		const second = compileBlueprintArtifact(withoutBudget, baseContext());
		expect(first.artifactHash).not.toBe(second.artifactHash);
		expect(first.budgets).toEqual({ maxToolCalls: 10 });
	});

	it("does not hash sourcePath or compiledAt (machine/time independent)", () => {
		const definition = compileAgentDefinition(
			{ name: "agent", adapters: [{ name: "fs" }] },
			{ sourcePath: "/some/machine/specific/path/agent.yaml" },
		);
		const other = compileAgentDefinition({ name: "agent", adapters: [{ name: "fs" }] }, { sourcePath: undefined });
		const first = compileBlueprintArtifact(definition, baseContext());
		const second = compileBlueprintArtifact(other, baseContext());
		expect(first.artifactHash).toBe(second.artifactHash);
		expect(first.sourcePath).not.toBe(second.sourcePath);
	});

	it("captures command ownership and declared ports", () => {
		const definition = compileAgentDefinition({
			name: "agent",
			adapters: [{ name: "fs" }],
			surfaces: [{ type: "sse", port: 4200 }],
		});
		const artifact = compileBlueprintArtifact(definition, baseContext());
		expect(artifact.commandOwnership).toEqual({ "fs.read": "fs", "fs.write": "fs" });
		expect(artifact.ports).toEqual([{ type: "sse", port: 4200 }]);
	});

	it("is deeply frozen -- mutation throws in strict mode", () => {
		const definition = compileAgentDefinition({ name: "agent", adapters: [{ name: "fs" }] });
		const artifact = compileBlueprintArtifact(definition, baseContext());
		expect(Object.isFrozen(artifact)).toBe(true);
		expect(Object.isFrozen(artifact.packages)).toBe(true);
		expect(Object.isFrozen(artifact.permissions)).toBe(true);
		expect(() => {
			// @ts-expect-error -- intentional mutation attempt against a readonly field
			artifact.name = "mutated";
		}).toThrow();
	});
});

describe("computeArtifactHash", () => {
	it("is independent of key order", () => {
		expect(computeArtifactHash({ a: 1, b: 2 })).toBe(computeArtifactHash({ b: 2, a: 1 }));
	});

	it("differs for different values", () => {
		expect(computeArtifactHash({ a: 1 })).not.toBe(computeArtifactHash({ a: 2 }));
	});
});
