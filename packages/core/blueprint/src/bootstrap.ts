import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 *
 */
export type BootstrapBlueprintId = "gensec" | "2sec" | "primordial";

/**
 *
 */
export interface MaterializedBootstrapBlueprint {
	id: BootstrapBlueprintId;
	label: string;
	sourcePath: string;
	targetPath: string;
}

/**
 *
 */
export interface MaterializedBootstrapBlueprintSet {
	entries: Record<BootstrapBlueprintId, MaterializedBootstrapBlueprint>;
}

const SHIPPED_BLUEPRINT_FILES: Record<BootstrapBlueprintId, { fileName: string; label: string }> = {
	gensec: { fileName: "gensec.yaml", label: "GenSec" },
	"2sec": { fileName: "2sec.yaml", label: "2Sec" },
	primordial: { fileName: "primordial.yaml", label: "Primordial" },
};

/**
 *
 */
function getShippedBootstrapBlueprintDir(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "..", "examples", "bootstrap");
}

/**
 *
 */
export function resolveBootstrapBlueprintPath(id: BootstrapBlueprintId): string {
	const blueprint = SHIPPED_BLUEPRINT_FILES[id];
	return join(getShippedBootstrapBlueprintDir(), blueprint.fileName);
}

/**
 *
 */
export function ensureBootstrapBlueprints(agentDir: string): MaterializedBootstrapBlueprintSet {
	const targetDir = join(agentDir, "blueprints", "bootstrap");
	if (!existsSync(targetDir)) {
		mkdirSync(targetDir, { recursive: true });
	}

	const entries: Partial<Record<BootstrapBlueprintId, MaterializedBootstrapBlueprint>> = {};
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Object.entries loses literal key types
	for (const [id, blueprint] of Object.entries(SHIPPED_BLUEPRINT_FILES) as Array<
		[BootstrapBlueprintId, { fileName: string; label: string }]
	>) {
		const sourcePath = resolveBootstrapBlueprintPath(id);
		const targetPath = join(targetDir, blueprint.fileName);
		if (!existsSync(sourcePath)) {
			throw new Error(`Bootstrap blueprint is missing from the package: ${sourcePath}`);
		}
		if (!existsSync(targetPath)) {
			copyFileSync(sourcePath, targetPath);
		}
		entries[id] = {
			id,
			label: blueprint.label,
			sourcePath,
			targetPath,
		};
	}

	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- incrementally populated, complete after loop
	return { entries: entries as Record<BootstrapBlueprintId, MaterializedBootstrapBlueprint> };
}
