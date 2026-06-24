import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverBlueprints, resolveBlueprint } from "../src/cli/blueprint-picker.js";

const dirs: string[] = [];
function makeTmp(): string {
	const d = mkdtempSync(join(tmpdir(), "alef-bp-test-"));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function writeBlueprint(dir: string, filename: string, name: string, desc: string): string {
	const path = join(dir, filename);
	writeFileSync(path, `name: ${name}\ndescription: ${desc}\norgans:\n  - name: fs\n`);
	return path;
}

describe("blueprint discovery", { tags: ["unit"] }, () => {
	it("discovers blueprints in .alef/blueprints/", () => {
		const cwd = makeTmp();
		const bpDir = join(cwd, ".alef/blueprints");
		mkdirSync(bpDir, { recursive: true });
		writeBlueprint(bpDir, "coding.yaml", "coding", "Minimal coding agent");
		writeBlueprint(bpDir, "research.yaml", "research", "Coding + Locus + Scribe");

		const found = discoverBlueprints(cwd);
		expect(found).toHaveLength(2);
		expect(found.map((b) => b.name).sort()).toEqual(["coding", "research"]);
	});

	it("deduplicates by name", () => {
		const cwd = makeTmp();
		const dir1 = join(cwd, ".alef/blueprints");
		const dir2 = join(cwd, "blueprints");
		mkdirSync(dir1, { recursive: true });
		mkdirSync(dir2, { recursive: true });
		writeBlueprint(dir1, "coding.yaml", "coding", "Local");
		writeBlueprint(dir2, "coding.yaml", "coding", "Project");

		const found = discoverBlueprints(cwd);
		expect(found).toHaveLength(1);
		expect(found[0].description).toBe("Local");
	});

	it("returns empty for no blueprints", () => {
		const cwd = makeTmp();
		expect(discoverBlueprints(cwd)).toHaveLength(0);
	});
});

describe("blueprint resolution", { tags: ["unit"] }, () => {
	it("resolves absolute path directly", () => {
		const cwd = makeTmp();
		const dir = join(cwd, ".alef/blueprints");
		mkdirSync(dir, { recursive: true });
		const path = writeBlueprint(dir, "test.yaml", "test", "Test");
		expect(resolveBlueprint(path, cwd)).toBe(path);
	});

	it("resolves by name from discovered blueprints", () => {
		const cwd = makeTmp();
		const dir = join(cwd, ".alef/blueprints");
		mkdirSync(dir, { recursive: true });
		writeBlueprint(dir, "research.yaml", "research", "Research agent");

		const resolved = resolveBlueprint("research", cwd);
		expect(resolved).toBeDefined();
		expect(resolved).toContain("research.yaml");
	});

	it("returns undefined for unknown name", () => {
		const cwd = makeTmp();
		expect(resolveBlueprint("nonexistent", cwd)).toBeUndefined();
	});
});
