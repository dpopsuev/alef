import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type BootstrapBlueprintId = "gensec" | "2sec" | "primordial";

export interface MaterializedBootstrapBlueprint {
	id: BootstrapBlueprintId;
	label: string;
	sourcePath: string;
	targetPath: string;
}

export interface MaterializedBootstrapBlueprintSet {
	entries: Record<BootstrapBlueprintId, MaterializedBootstrapBlueprint>;
}

const SHIPPED_BLUEPRINT_FILES: Record<BootstrapBlueprintId, { fileName: string; label: string }> = {
	gensec: { fileName: "gensec.yaml", label: "GenSec" },
	"2sec": { fileName: "2sec.yaml", label: "2Sec" },
	primordial: { fileName: "primordial.yaml", label: "Primordial" },
};

function getShippedBootstrapBlueprintDir(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "..", "examples", "bootstrap");
}

export function ensureBootstrapBlueprints(agentDir: string): MaterializedBootstrapBlueprintSet {
	const sourceDir = getShippedBootstrapBlueprintDir();
	const targetDir = join(agentDir, "blueprints", "bootstrap");
	if (!existsSync(targetDir)) {
		mkdirSync(targetDir, { recursive: true });
	}

	const entries = {} as Record<BootstrapBlueprintId, MaterializedBootstrapBlueprint>;
	for (const [id, blueprint] of Object.entries(SHIPPED_BLUEPRINT_FILES) as Array<
		[BootstrapBlueprintId, { fileName: string; label: string }]
	>) {
		const sourcePath = join(sourceDir, blueprint.fileName);
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

	return { entries };
}
