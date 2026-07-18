/**
 * Single mount path for tests: package blueprint.yaml → materializeBlueprint → createAdapter.
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAgentDefinition } from "@dpopsuev/alef-blueprint/blueprints";
import { materializeBlueprint } from "@dpopsuev/alef-blueprint/materializer";
import type { Adapter } from "@dpopsuev/alef-kernel/adapter";

export const DOT_BLUEPRINT_PATH = fileURLToPath(new URL("../blueprint.yaml", import.meta.url));
export const DOT_PACKAGE_DIR = dirname(DOT_BLUEPRINT_PATH);

/** Materialize the package SBOM — same path as production / BlueprintHarness. */
export async function materializeDotAdapters(cwd: string = DOT_PACKAGE_DIR): Promise<Adapter[]> {
	const definition = loadAgentDefinition(DOT_BLUEPRINT_PATH);
	const result = await materializeBlueprint(definition, { cwd });
	return result.adapters;
}
