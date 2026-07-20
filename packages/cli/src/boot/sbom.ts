/**
 * SBOM (Software Bill of Materials) types and loader.
 *
 * The SBOM is generated at build time by scripts/generate-sbom.ts
 * and records per-component content hashes. The restart policy diffs
 * old vs new SBOM to determine the minimum restart scope.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Restart scope for a component -- determines what to restart on change. */
export type RestartScope = "exit" | "tui" | "supervisor" | "adapter" | "none";

/** A single component in the SBOM. */
export interface SbomComponent {
	name: string;
	scope: RestartScope;
	hash: string;
	files: number;
}

/** The full SBOM structure. */
export interface Sbom {
	version: 1;
	generatedAt: string;
	gitHash: string;
	components: SbomComponent[];
}

/** Load the SBOM from the workspace root. Returns null if not found. */
export function loadSbom(rootDir?: string): Sbom | null {
	const root = rootDir ?? resolve(import.meta.dirname, "../../../..");
	try {
		const raw = readFileSync(resolve(root, "sbom.json"), "utf-8");
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- sbom.json schema controlled by generate-sbom.ts
		return JSON.parse(raw) as Sbom;
	} catch {
		return null;
	}
}
