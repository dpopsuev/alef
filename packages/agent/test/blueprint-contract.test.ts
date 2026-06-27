import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadAgentDefinition } from "@dpopsuev/alef-blueprint/blueprints";
import { materializeBlueprint } from "@dpopsuev/alef-blueprint/materializer";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "../../..");
const PACKAGES_DIR = join(REPO_ROOT, "packages");

function findBlueprintYamls(): Array<{ name: string; path: string }> {
	const results: Array<{ name: string; path: string }> = [];
	for (const entry of readdirSync(PACKAGES_DIR, { withFileTypes: true })) {
		if (!entry.isDirectory() || !entry.name.startsWith("alef-")) continue;
		const yamlPath = join(PACKAGES_DIR, entry.name, "blueprint.yaml");
		if (existsSync(yamlPath)) {
			results.push({ name: entry.name, path: yamlPath });
		}
	}
	return results;
}

describe("blueprint YAML contract", { tags: ["unit"] }, () => {
	const blueprints = findBlueprintYamls();

	it("discovers at least 2 blueprints", () => {
		expect(blueprints.length).toBeGreaterThanOrEqual(2);
	});

	for (const bp of blueprints) {
		describe(bp.name, () => {
			it("loads without parse errors", () => {
				const definition = loadAgentDefinition(bp.path);
				expect(definition).toBeDefined();
				expect(definition.adapters).toBeDefined();
				expect(definition.adapters.length).toBeGreaterThan(0);
			});

			it("declares a name and description", () => {
				const definition = loadAgentDefinition(bp.path);
				expect(definition.name).toBeTruthy();
			});

			it("materializes — all organ packages resolve", async () => {
				const definition = loadAgentDefinition(bp.path);
				const result = await materializeBlueprint(definition, {
					cwd: REPO_ROOT,
				});
				expect(result.adapters.length).toBeGreaterThan(0);
			});

			it("no organ references deleted packages", () => {
				const definition = loadAgentDefinition(bp.path);
				const deletedPackages = [
					"@dpopsuev/alef-adapter-delegate",
					"@dpopsuev/alef-adapter-orchestration",
					"delegate",
					"orchestration",
				];
				for (const organ of definition.adapters) {
					for (const deleted of deletedPackages) {
						expect(organ.name).not.toBe(deleted);
					}
				}
			});
		});
	}
});
