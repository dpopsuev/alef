import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blueprintRegistry } from "@dpopsuev/alef-blueprint/registry";
import { afterEach, describe, expect, it } from "vitest";
import { discoverBlueprints, resolveBlueprint } from "../src/boot/blueprints.js";

describe("blueprint discovery (registry-based)", { tags: ["unit"] }, () => {
	const registered: string[] = [];

	afterEach(() => {
		registered.splice(0);
	});

	function register(name: string): void {
		blueprintRegistry.register(name, async () => ({ adapters: [], contextAssembly: undefined as never }));
		registered.push(name);
	}

	it("discovers registered blueprints", () => {
		register("test-coding-bp");
		register("test-research-bp");

		const found = discoverBlueprints();
		const names = found.map((b) => b.name);
		expect(names).toContain("test-coding-bp");
		expect(names).toContain("test-research-bp");
	});

	it("returns registered blueprints only", () => {
		const before = discoverBlueprints().length;
		register("test-new-bp");
		expect(discoverBlueprints()).toHaveLength(before + 1);
	});
});

describe("blueprint resolution", { tags: ["unit"] }, () => {
	const dirs: string[] = [];
	const registered: string[] = [];

	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
		registered.splice(0);
	});

	it("resolves absolute path directly", () => {
		const d = mkdtempSync(join(tmpdir(), "alef-bp-"));
		dirs.push(d);
		const path = join(d, "test.yaml");
		writeFileSync(path, "name: test\n");
		expect(resolveBlueprint(path)).toBe(path);
	});

	it("resolves by name from registered blueprints", () => {
		blueprintRegistry.register("test-research", async () => ({ adapters: [], contextAssembly: undefined as never }));
		registered.push("test-research");

		expect(resolveBlueprint("test-research")).toBe("test-research");
	});

	it("returns undefined for unknown name", () => {
		expect(resolveBlueprint("nonexistent-xyz-999")).toBeUndefined();
	});
});
