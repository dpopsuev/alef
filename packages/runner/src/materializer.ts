/**
 * Blueprint materializer — loads Organ instances from a CompiledAgentDefinition.
 *
 * No per-organ knowledge. No if-chains. No pre-registration.
 * Each organ is loaded dynamically and must export createOrgan(opts).
 *
 * Resolution order per organ entry:
 *   path  → jiti.import(resolvedPath)       — TypeScript file, no build step
 *   name  → import(BUILTIN_PACKAGES[name])  — built-in alias
 *   name  → import(name)                    — treated as npm package specifier
 *
 * Factory convention:
 *   Each organ module exports createOrgan(opts: OrganFactoryOptions): Organ.
 *   The materializer calls it with { cwd, actions, logger }. Unknown options
 *   are ignored — each organ's factory handles only what it needs.
 */

import type { CompiledAgentDefinition } from "@dpopsuev/alef-agent-blueprint";
import { BUILTIN_PACKAGES } from "@dpopsuev/alef-agent-blueprint";
import type { Organ, OrganLogger } from "@dpopsuev/alef-spine";
import { createJiti } from "jiti";

/** Common options passed to every organ factory. */
export interface OrganFactoryOptions {
	cwd: string;
	actions?: string[];
	logger?: OrganLogger;
}

/** Expected shape of an organ module — must export createOrgan. */
interface OrganModule {
	createOrgan: (opts: OrganFactoryOptions) => Organ;
}

export interface MaterializerOptions {
	cwd: string;
	loggerFor?: (organName: string) => OrganLogger;
}

export interface MaterializerResult {
	organs: Organ[];
	modelId: string | undefined;
}

/**
 * Default organ set used when no --blueprint is supplied.
 * Keeps main.ts free of organ imports — the materializer is the only
 * instantiation path for both blueprint and bare invocations.
 */
export const DEFAULT_COMPILED_DEFINITION: CompiledAgentDefinition = {
	name: "default",
	organs: [
		{ name: "fs", package: BUILTIN_PACKAGES.fs, path: undefined, actions: [], toolNames: [] },
		{ name: "shell", package: BUILTIN_PACKAGES.shell, path: undefined, actions: [], toolNames: [] },
		{ name: "nodesh", package: BUILTIN_PACKAGES.nodesh, path: undefined, actions: [], toolNames: [] },
	],
	model: undefined,
	children: [],
	surfaces: [],
	capabilities: { tools: [], supervisor: false },
	memory: { session: "memory", working: {} },
	policies: { appendSystemPrompt: [] },
	hooks: { extensions: [] },
};

let _jiti: ReturnType<typeof createJiti> | undefined;
function getJiti(): ReturnType<typeof createJiti> {
	if (!_jiti) {
		_jiti = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
	}
	return _jiti;
}

async function loadOrganModule(organDef: CompiledAgentDefinition["organs"][number]): Promise<OrganModule> {
	if (organDef.path) {
		// TypeScript file — load via jiti without a build step.
		const jitiMod = await getJiti().import(organDef.path);
		const mod = jitiMod as Record<string, unknown>;
		if (typeof mod.createOrgan !== "function") {
			throw new Error(
				`Organ at '${organDef.path}' does not export createOrgan(opts). ` +
					`Export a function named createOrgan that returns an Organ.`,
			);
		}
		return mod as unknown as OrganModule;
	}

	const pkg = organDef.package ?? organDef.name;
	// Dynamic import — works for both built-in monorepo packages and npm packages.
	// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
	const rawMod = await import(pkg);
	const mod = rawMod as unknown as Record<string, unknown>;
	if (typeof mod.createOrgan !== "function") {
		throw new Error(
			`Organ package '${pkg}' does not export createOrgan(opts). ` +
				`Add \`export { createYourOrgan as createOrgan } from "./organ.js"\` to its index.`,
		);
	}
	return mod as unknown as OrganModule;
}

export async function materializeBlueprint(
	definition: CompiledAgentDefinition,
	opts: MaterializerOptions,
): Promise<MaterializerResult> {
	const organs: Organ[] = [];

	for (const organDef of definition.organs) {
		// Skip legacy/unimplemented organs silently.
		// ai and discourse are mounted by main.ts; symbols/supervisor are roadmap.
		if (["ai", "discourse", "symbols", "supervisor"].includes(organDef.name)) continue;

		const label = organDef.path ? organDef.path : (organDef.package ?? organDef.name);
		try {
			const mod = await loadOrganModule(organDef);
			const organ = mod.createOrgan({
				cwd: opts.cwd,
				actions: organDef.actions.length > 0 ? organDef.actions : undefined,
				logger: opts.loggerFor?.(organDef.name),
			});
			organs.push(organ);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			// Warn but don't crash for unsupported/roadmap organs.
			if (msg.includes("does not export createOrgan")) {
				console.warn(`[blueprint] ${msg} Skipping.`);
			} else {
				throw new Error(`[blueprint] Failed to load organ '${label}': ${msg}`);
			}
		}
	}

	let modelId: string | undefined;
	if (definition.model) {
		modelId = `${definition.model.provider}/${definition.model.id}`;
	}

	return { organs, modelId };
}
