/**
 * Organ compilation — converts YAML organ inputs into materializer instructions.
 *
 * Purely structural: validates shape, resolves paths, passes names through.
 * Zero knowledge of specific organ packages — alias resolution is the
 * materializer's concern (it is the composition root that ships the organs).
 */

import type { AgentDefinitionOrganInput, AgentRole, CompiledAgentOrganDefinition } from "./types.js";

/**
 * Compile organ inputs from YAML into materializer-ready descriptors.
 *
 * Each entry must have either:
 *   name  — an npm package specifier OR a short alias the materializer recognises
 *   path  — path to a TypeScript file (resolved relative to baseDir)
 *
 * Blueprint does NOT resolve aliases; the materializer does.
 */
export function compileAgentOrganDefinitions(
	inputs: AgentDefinitionOrganInput[] | undefined,
	_role: AgentRole = "root",
	baseDir?: string,
): CompiledAgentOrganDefinition[] {
	if (!inputs || inputs.length === 0) return [];

	const seen = new Set<string>();
	return inputs.map((input) => {
		if (!input.name && !input.path) {
			throw new Error("Adapter entry must specify either 'name' (package or alias) or 'path' (TypeScript file).");
		}
		if (input.name && input.path) {
			throw new Error(
				`Adapter entry cannot specify both 'name' and 'path'. Got name="${input.name}" path="${input.path}".`,
			);
		}

		const key = input.path ?? input.name ?? "";
		if (seen.has(key)) throw new Error(`Duplicate organ "${key}" in agent definition.`);
		seen.add(key);

		let resolvedPath: string | undefined;
		if (input.path) {
			resolvedPath = baseDir && !input.path.startsWith("/") ? `${baseDir}/${input.path}` : input.path;
		}

		return {
			name: input.name ?? "_external",
			path: resolvedPath,
			actions: input.actions ?? [],
			toolNames: [],
			blockedPatterns: input.blockedPatterns,
		};
	});
}

/** @deprecated EDA organs self-describe at mount time. Returns empty for compatibility. */
export function listToolNamesForOrgans(_organs: CompiledAgentOrganDefinition[]): string[] {
	return [];
}
