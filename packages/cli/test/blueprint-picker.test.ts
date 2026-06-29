import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discoverBlueprints, resolveBlueprint } from "../src/boot/blueprints.js";

vi.mock("../src/pkg/alef-pm.js", () => ({
	listInstalled: vi.fn().mockReturnValue([]),
	resolveAdapterPath: vi.fn(),
}));

import { listInstalled } from "../src/pkg/alef-pm.js";

const mockedListInstalled = vi.mocked(listInstalled);

describe("blueprint discovery (PM-based)", { tags: ["unit"] }, () => {
	beforeEach(() => {
		mockedListInstalled.mockReturnValue([]);
	});

	it("discovers blueprints with type=blueprint from PM", () => {
		mockedListInstalled.mockReturnValue([
			{
				name: "coding-bp",
				version: "1.0.0",
				description: "Coding agent",
				manifest: { type: "blueprint", entry: "/pm/coding/index.ts" },
				entry: "/pm/coding/index.ts",
			},
			{
				name: "research-bp",
				version: "1.0.0",
				description: "Research agent",
				manifest: { type: "blueprint", entry: "/pm/research/index.ts" },
				entry: "/pm/research/index.ts",
			},
			{
				name: "some-tool",
				version: "1.0.0",
				description: "A tool",
				manifest: { type: "tool", entry: "/pm/tool/index.ts" },
				entry: "/pm/tool/index.ts",
			},
		]);

		const found = discoverBlueprints();
		expect(found).toHaveLength(2);
		expect(found.map((b) => b.name).sort()).toEqual(["coding-bp", "research-bp"]);
	});

	it("ignores packages without blueprint type", () => {
		mockedListInstalled.mockReturnValue([
			{
				name: "my-tool",
				version: "1.0.0",
				description: "Tool",
				manifest: { type: "tool", entry: "index.ts" },
				entry: "/pm/index.ts",
			},
		]);

		expect(discoverBlueprints()).toHaveLength(0);
	});

	it("returns empty when no packages installed", () => {
		expect(discoverBlueprints()).toHaveLength(0);
	});
});

describe("blueprint resolution", { tags: ["unit"] }, () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	it("resolves absolute path directly", () => {
		const d = mkdtempSync(join(tmpdir(), "alef-bp-"));
		dirs.push(d);
		const path = join(d, "test.yaml");
		writeFileSync(path, "name: test\n");
		expect(resolveBlueprint(path)).toBe(path);
	});

	it("resolves by name from PM-installed blueprints", () => {
		mockedListInstalled.mockReturnValue([
			{
				name: "research",
				version: "1.0.0",
				description: "Research",
				manifest: { type: "blueprint", entry: "/pm/research.ts" },
				entry: "/pm/research.ts",
			},
		]);

		const resolved = resolveBlueprint("research");
		expect(resolved).toBe("/pm/research.ts");
	});

	it("returns undefined for unknown name", () => {
		expect(resolveBlueprint("nonexistent")).toBeUndefined();
	});
});
