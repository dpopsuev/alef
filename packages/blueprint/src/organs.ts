/**
 * Organ compilation — converts YAML organ inputs into materializer instructions.
 *
 * No pre-registration. No capability enumeration. No if-chains.
 * The materializer resolves and loads organs; the organs describe themselves.
 *
 * Built-in aliases map short names to their npm packages so agent.yaml
 * can write `name: fs` instead of `package: @dpopsuev/alef-organ-fs`.
 * Adding a new organ requires only adding one line to BUILTIN_PACKAGES.
 */

import type { AgentDefinitionOrganInput, AgentRole, CompiledAgentOrganDefinition } from "./types.js";

/** Short name → npm package for built-in organs shipped with Alef. */
export const BUILTIN_PACKAGES: Record<string, string> = {
	fs: "@dpopsuev/alef-organ-fs",
	shell: "@dpopsuev/alef-organ-shell",
	nodesh: "@dpopsuev/alef-organ-nodesh",
	lector: "@dpopsuev/alef-organ-lector",
	supervisor: "@dpopsuev/alef-organ-supervisor",
	eval: "@dpopsuev/alef-organ-eval",
};

/**
 * Compile organ inputs from YAML into materializer-ready descriptors.
 *
 * Validates that each entry has either `name` (built-in alias or npm package)
 * or `path` (TypeScript file), but does NOT instantiate or import anything.
 * Instantiation is the materializer's job.
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
			throw new Error("Organ entry must specify either 'name' (built-in or package) or 'path' (TypeScript file).");
		}
		if (input.name && input.path) {
			throw new Error(
				`Organ entry cannot specify both 'name' and 'path'. Got name="${input.name}" path="${input.path}".`,
			);
		}

		const key = input.path ?? input.name ?? "";
		if (seen.has(key)) {
			throw new Error(`Duplicate organ "${key}" in agent definition.`);
		}
		seen.add(key);

		// Resolve relative paths against the blueprint file's directory.
		let resolvedPath: string | undefined;
		if (input.path) {
			resolvedPath = baseDir && !input.path.startsWith("/") ? `${baseDir}/${input.path}` : input.path;
		}

		// Resolve built-in alias to package name; otherwise treat name as a package specifier.
		const pkg = input.name ? (BUILTIN_PACKAGES[input.name] ?? input.name) : undefined;

		return {
			name: input.name ?? "_external",
			package: pkg,
			path: resolvedPath,
			actions: input.actions ?? [],
			toolNames: [], // populated by the organ itself at mount time
		};
	});
}

/** @deprecated EDA organs self-describe at mount time. Returns empty for compatibility. */
export function listToolNamesForOrgans(_organs: CompiledAgentOrganDefinition[]): string[] {
	return [];
}
