/**
 * SBOM diff -- compare two SBOMs and determine the minimum restart scope.
 *
 * Restart scope priority (highest wins):
 *   exit > tui > supervisor > adapter > none
 *
 * When multiple components change, the overall restart scope is the highest
 * priority among all changed components. Adapter changes also report which
 * adapters need hot-reload.
 */

import type { RestartScope, Sbom, SbomComponent } from "./sbom.js";

/** A component that changed between two SBOMs. */
export interface ChangedComponent {
	name: string;
	scope: RestartScope;
	oldHash: string;
	newHash: string;
}

/** Result of diffing two SBOMs. */
export interface SbomDiffResult {
	/** The highest-priority restart scope needed. "none" if nothing changed. */
	restartScope: RestartScope;
	/** Components whose hashes changed. */
	changed: ChangedComponent[];
	/** Components added in the new SBOM (not present in old). */
	added: SbomComponent[];
	/** Components removed from the new SBOM (present in old, not new). */
	removed: SbomComponent[];
	/** Adapter names that need hot-reload (only when restartScope is "adapter"). */
	adaptersToReload: string[];
}

const SCOPE_PRIORITY: Record<RestartScope, number> = {
	exit: 4,
	tui: 3,
	supervisor: 2,
	adapter: 1,
	none: 0,
};

/** Compare two SBOMs and compute the minimum restart scope. */
export function diffSbom(oldSbom: Sbom, newSbom: Sbom): SbomDiffResult {
	const oldMap = new Map(oldSbom.components.map((c) => [c.name, c]));
	const newMap = new Map(newSbom.components.map((c) => [c.name, c]));

	const changed: ChangedComponent[] = [];
	const added: SbomComponent[] = [];
	const removed: SbomComponent[] = [];

	for (const [name, newComp] of newMap) {
		const oldComp = oldMap.get(name);
		if (!oldComp) {
			added.push(newComp);
		} else if (oldComp.hash !== newComp.hash) {
			changed.push({
				name,
				scope: newComp.scope,
				oldHash: oldComp.hash,
				newHash: newComp.hash,
			});
		}
	}

	for (const [name, oldComp] of oldMap) {
		if (!newMap.has(name)) {
			removed.push(oldComp);
		}
	}

	let maxScope: RestartScope = "none";

	for (const c of changed) {
		if (SCOPE_PRIORITY[c.scope] > SCOPE_PRIORITY[maxScope]) {
			maxScope = c.scope;
		}
	}

	for (const c of added) {
		if (SCOPE_PRIORITY[c.scope] > SCOPE_PRIORITY[maxScope]) {
			maxScope = c.scope;
		}
	}

	for (const c of removed) {
		if (SCOPE_PRIORITY[c.scope] > SCOPE_PRIORITY[maxScope]) {
			maxScope = c.scope;
		}
	}

	const adaptersToReload =
		maxScope === "adapter"
			? [...changed, ...added].filter((c) => c.scope === "adapter").map((c) => c.name.replace(/^adapter:/, ""))
			: [];

	return { restartScope: maxScope, changed, added, removed, adaptersToReload };
}
