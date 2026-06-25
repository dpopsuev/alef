import { describe, expect, it } from "vitest";
import "@dpopsuev/alef-coding-agent";
import "@dpopsuev/alef-factory-agent";
import { blueprintRegistry } from "@dpopsuev/alef-blueprint";

describe("blueprintRegistry.resolve", { tags: ["unit"] }, () => {
	it("resolves default when no name provided", () => {
		const factory = blueprintRegistry.resolve();
		expect(factory).toBeDefined();
	});

	it("resolves coding agent by name", () => {
		const factory = blueprintRegistry.resolve("alef-coding-agent");
		expect(factory).toBeDefined();
	});

	it("resolves factory agent by name", () => {
		const factory = blueprintRegistry.resolve("alef-factory-agent");
		expect(factory).toBeDefined();
	});

	it("returns undefined for unknown blueprint", () => {
		const factory = blueprintRegistry.resolve("nonexistent-blueprint");
		expect(factory).toBeUndefined();
	});

	it("default is coding agent, not factory agent", () => {
		const defaultFactory = blueprintRegistry.resolve();
		const codingFactory = blueprintRegistry.resolve("alef-coding-agent");
		expect(defaultFactory).toBe(codingFactory);
	});

	it("factory agent is distinct from coding agent", () => {
		const coding = blueprintRegistry.resolve("alef-coding-agent");
		const factory = blueprintRegistry.resolve("alef-factory-agent");
		expect(coding).not.toBe(factory);
	});

	it("lists all registered blueprints", () => {
		const names = blueprintRegistry.list();
		expect(names).toContain("alef-coding-agent");
		expect(names).toContain("alef-factory-agent");
	});

	it("LoadResult.blueprintName drives resolve — simulates picker flow", () => {
		const pickedName = "alef-factory-agent";
		const resolved = blueprintRegistry.resolve(pickedName);
		const defaultResolved = blueprintRegistry.resolve();
		expect(resolved).toBeDefined();
		expect(resolved).not.toBe(defaultResolved);
	});
});
