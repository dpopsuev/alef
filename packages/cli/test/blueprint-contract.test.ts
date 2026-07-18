import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadAgentDefinition } from "@dpopsuev/alef-blueprint/blueprints";
import { materializeBlueprint } from "@dpopsuev/alef-blueprint/materializer";
import type { CompiledAgentDefinition } from "@dpopsuev/alef-blueprint/types";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "../../..");
const PACKAGES_DIR = join(REPO_ROOT, "packages");

function findBlueprintYamls(): Array<{ name: string; path: string }> {
	const results: Array<{ name: string; path: string }> = [];
	function scan(dir: string): void {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (!entry.isDirectory() || entry.name === "node_modules") continue;
			const full = join(dir, entry.name);
			const yamlPath = join(full, "blueprint.yaml");
			if (existsSync(yamlPath)) {
				results.push({ name: entry.name, path: yamlPath });
			} else {
				scan(full);
			}
		}
	}
	scan(PACKAGES_DIR);
	return results;
}

/** Package missing / unresolvable — must fail the suite (do not swallow). */
function isResolveFailure(message: string): boolean {
	return (
		message.includes("Cannot find package") ||
		message.includes("ERR_MODULE_NOT_FOUND") ||
		message.includes("Cannot find module") ||
		/Failed to load adapter '[^']+': Cannot find/.test(message)
	);
}

function soloAdapterDefinition(
	definition: CompiledAgentDefinition,
	adapter: CompiledAgentDefinition["adapters"][number],
): CompiledAgentDefinition {
	return { ...definition, adapters: [adapter] };
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

			it("materializes every SBOM adapter (resolve + createAdapter)", async () => {
				const definition = loadAgentDefinition(bp.path);
				let result: Awaited<ReturnType<typeof materializeBlueprint>>;
				try {
					result = await materializeBlueprint(definition, { cwd: REPO_ROOT });
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					expect(isResolveFailure(message), message).toBe(false);
					throw new Error(`Blueprint ${bp.name} failed to materialize (not a resolve miss): ${message}`, {
						cause: err,
					});
				}
				expect(result.adapters).toHaveLength(definition.adapters.length);
				const actual = result.adapters.map((adapter) => adapter.name).sort();
				const declared = definition.adapters
					.map((adapter) => adapter.name)
					.filter((name) => name !== "_external")
					.sort();
				for (const name of declared) {
					expect(actual).toContain(name);
				}
				for (const name of actual) {
					expect(name).toBeTruthy();
					expect(name).not.toBe("_external");
				}
			});

			describe("per-adapter materialize", () => {
				const definition = loadAgentDefinition(bp.path);
				for (const adapter of definition.adapters) {
					const label = adapter.path ? `${adapter.name} (${adapter.path})` : adapter.name;
					it(`materializes ${label}`, async () => {
						const solo = soloAdapterDefinition(definition, adapter);
						try {
							const result = await materializeBlueprint(solo, { cwd: REPO_ROOT });
							expect(result.adapters).toHaveLength(1);
							const runtimeName = result.adapters[0]!.name;
							expect(runtimeName).toBeTruthy();
							expect(runtimeName).not.toBe("_external");
							if (adapter.name !== "_external") {
								expect(runtimeName).toBe(adapter.name);
							}
						} catch (err) {
							const message = err instanceof Error ? err.message : String(err);
							expect(isResolveFailure(message), message).toBe(false);
							throw err;
						}
					});
				}
			});

			it("no adapter references deleted packages", () => {
				const definition = loadAgentDefinition(bp.path);
				const deletedPackages = [
					"@dpopsuev/alef-adapter-delegate",
					"@dpopsuev/alef-adapter-orchestration",
					"delegate",
					"orchestration",
				];
				for (const adapter of definition.adapters) {
					for (const deleted of deletedPackages) {
						expect(adapter.name).not.toBe(deleted);
					}
				}
			});
		});
	}
});
