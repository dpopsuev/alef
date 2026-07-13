import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
	findAgentDefinitionPath,
	loadAgentDefinition,
	mergeAgentDefinitions,
} from "@dpopsuev/alef-blueprint/blueprints";
import {
	CODING_AGENT_BLUEPRINT,
	DEFAULT_COMPILED_DEFINITION,
	loadUserAdaptersConfig,
	materializeBlueprint,
} from "@dpopsuev/alef-blueprint/materializer";
import type { AgentDefinitionSurfaceInput, CompiledAgentDefinition } from "@dpopsuev/alef-blueprint/types";
import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import type { Logger } from "pino";
import { resolveAdapterPath } from "../pkg/alef-pm.js";
import type { Args } from "./args.js";
import { discoverBlueprints, pickBlueprint, resolveBlueprint } from "./blueprints.js";
import type { AlefConfig } from "./config.js";

const require = createRequire(import.meta.url);

/**
 * Resolve writable_roots from config (or inherited env var), substituting placeholders.
 * Returns undefined = unrestricted (no guard).
 *
 * Resolution order:
 *   1. config.security.writable_roots (explicit user config)
 *   2. ALEF_WRITABLE_ROOTS env var (propagated from parent via orchestration.spawn)
 *   3. undefined (unrestricted (no guard))
 */
export function resolveWritableRoots(cwd: string, cfg: AlefConfig): readonly string[] | undefined {
	const raw = cfg.security?.writable_roots;
	if (raw) {
		const CWD_PLACEHOLDER = "$" + "{cwd}";
		const TMPDIR_PLACEHOLDER = "$" + "{tmpdir}";
		return raw.map((r) => resolve(r.replace(CWD_PLACEHOLDER, cwd).replace(TMPDIR_PLACEHOLDER, tmpdir())));
	}
	const envRoots = process.env.ALEF_WRITABLE_ROOTS;
	if (envRoots) {
		try {
			const parsed: unknown = JSON.parse(envRoots);
			if (Array.isArray(parsed)) return (parsed as string[]).map((r) => resolve(r)); // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- Array.isArray narrows; elements are strings by convention
		} catch {
			/* malformed — treat as unrestricted */
		}
	}
	return undefined;
}

/** Resolved adapters, model, surfaces, and security grants from blueprint materialization. */
export interface AdapterLoadResult {
	adapters: Adapter[];
	blueprintModelId: string | undefined;
	blueprintName: string | undefined;
	blueprintSurfaces: AgentDefinitionSurfaceInput[];
	blueprintUpgradePolicy: "rebuild_only" | "packages" | "self";
	blueprintPath: string | undefined;
	writableRoots: readonly string[] | undefined;
}

/** Map registry stack names to their published package blueprint.yaml export. */
const REGISTRY_BLUEPRINT_EXPORTS: Record<string, string> = {
	"alef-coding-agent": "@dpopsuev/alef-coding-agent/blueprint",
	"alef-factory-agent": "@dpopsuev/alef-factory-agent/blueprint",
};

/** Resolve a registry stack name to its on-disk SBOM YAML, if published. */
export function resolveRegistryBlueprintYaml(name: string): string | undefined {
	const spec = REGISTRY_BLUEPRINT_EXPORTS[name];
	if (!spec) return undefined;
	try {
		return require.resolve(spec);
	} catch {
		return undefined;
	}
}

/** Base definition for a registry stack: published YAML, else coding default. */
function baseDefinitionForRegistry(name: string | undefined): CompiledAgentDefinition {
	if (name) {
		const yamlPath = resolveRegistryBlueprintYaml(name);
		if (yamlPath) return loadAgentDefinition(yamlPath);
	}
	return CODING_AGENT_BLUEPRINT;
}

/** Discover and materialize adapters from a blueprint, CLI args, or user defaults. */
export async function loadAdapters(
	args: Args,
	cfg: AlefConfig,
	log: Logger,
	sessionDir?: string,
): Promise<AdapterLoadResult> {
	let blueprintPath: string | undefined;
	let blueprintName: string | undefined;
	/** True when the user pointed at a concrete YAML file (not a registry stack name). */
	let explicitYamlFile = false;
	let registrySelected = false;

	if (args.blueprint) {
		const resolved = resolveBlueprint(args.blueprint, args.cwd) ?? args.blueprint;
		blueprintName = args.blueprint;
		const { existsSync } = await import("node:fs");
		if (existsSync(resolved)) {
			blueprintPath = resolved;
			explicitYamlFile = true;
		} else {
			const looksLikePath = resolved.includes("/") || resolved.endsWith(".yaml") || resolved.endsWith(".yml");
			if (looksLikePath) {
				throw new Error(`Blueprint file not found: ${resolved}`);
			}
			registrySelected = true;
			blueprintPath = resolveRegistryBlueprintYaml(resolved) ?? resolveRegistryBlueprintYaml(args.blueprint);
			log.info({ blueprint: args.blueprint, path: blueprintPath }, "blueprint:registry-selected");
		}
	} else if (!args.print && !args.json && process.stdin.isTTY) {
		const discovered = discoverBlueprints();
		if (discovered.length > 1) {
			const chosen = await pickBlueprint(discovered);
			if (chosen) {
				blueprintName = chosen.name;
				const { existsSync } = await import("node:fs");
				if (existsSync(chosen.path)) {
					blueprintPath = chosen.path;
					explicitYamlFile = true;
				} else {
					registrySelected = true;
					blueprintPath = resolveRegistryBlueprintYaml(chosen.name);
					log.info({ blueprint: chosen.name, path: blueprintPath }, "blueprint:selected");
				}
			}
		}
	}

	const overlayPath = findAgentDefinitionPath(args.cwd);

	let definition: CompiledAgentDefinition | undefined;

	if (explicitYamlFile && blueprintPath) {
		definition = loadAgentDefinition(blueprintPath);
	} else if (registrySelected) {
		definition = baseDefinitionForRegistry(blueprintName);
		if (overlayPath) {
			definition = mergeAgentDefinitions(definition, loadAgentDefinition(overlayPath));
			blueprintPath = overlayPath;
		} else {
			blueprintPath = blueprintName ? resolveRegistryBlueprintYaml(blueprintName) : undefined;
		}
	} else if (overlayPath) {
		blueprintPath = overlayPath;
		definition = mergeAgentDefinitions(DEFAULT_COMPILED_DEFINITION, loadAgentDefinition(overlayPath));
	}

	if (definition && blueprintPath) {
		if (args.profile) {
			const { dirname: pathDirname, join: pathJoin } = await import("node:path");
			const { existsSync: fsExistsSync } = await import("node:fs");
			const baseDir = definition.baseDir ?? pathDirname(blueprintPath);
			const profileOverlay = pathJoin(baseDir, `agent.${args.profile}.yaml`);
			if (fsExistsSync(profileOverlay)) {
				definition = mergeAgentDefinitions(definition, loadAgentDefinition(profileOverlay));
			} else {
				console.error(`[alef] Profile overlay not found: ${profileOverlay} (continuing without it)`);
			}
		}

		const materialized = await materializeBlueprint(definition, {
			cwd: args.cwd,
			sessionDir,
			loggerFor: (name) => log.child({ adapter: name }),
			allowedTools: args.yolo ? ["*"] : cfg.permissions?.allowed_tools,
			writableRoots: resolveWritableRoots(args.cwd, cfg),
			resolveExternalPath: resolveAdapterPath,
		});

		return {
			adapters: materialized.adapters,
			blueprintModelId: materialized.modelId,
			blueprintName: blueprintName ?? definition.name,
			blueprintSurfaces: definition.surfaces,
			blueprintUpgradePolicy: definition.supervisor?.upgradePolicy ?? "rebuild_only",
			blueprintPath,
			writableRoots: resolveWritableRoots(args.cwd, cfg),
		};
	}

	if (definition) {
		const materialized = await materializeBlueprint(definition, {
			cwd: args.cwd,
			sessionDir,
			loggerFor: (name) => log.child({ adapter: name }),
			allowedTools: args.yolo ? ["*"] : cfg.permissions?.allowed_tools,
			writableRoots: resolveWritableRoots(args.cwd, cfg),
			resolveExternalPath: resolveAdapterPath,
		});
		return {
			adapters: materialized.adapters,
			blueprintModelId: materialized.modelId,
			blueprintName: blueprintName ?? definition.name,
			blueprintSurfaces: definition.surfaces,
			blueprintUpgradePolicy: definition.supervisor?.upgradePolicy ?? "rebuild_only",
			blueprintPath: undefined,
			writableRoots: resolveWritableRoots(args.cwd, cfg),
		};
	}

	const userAdapters = loadUserAdaptersConfig();
	const fallback = userAdapters
		? { ...DEFAULT_COMPILED_DEFINITION, adapters: userAdapters }
		: DEFAULT_COMPILED_DEFINITION;
	if (userAdapters) log.info({ count: userAdapters.length }, "loaded user adapters config");
	const defaultMaterialized = await materializeBlueprint(fallback, {
		cwd: args.cwd,
		sessionDir,
		loggerFor: (name) => log.child({ adapter: name }),
		allowedTools: args.yolo ? ["*"] : cfg.permissions?.allowed_tools,
		writableRoots: resolveWritableRoots(args.cwd, cfg),
		resolveExternalPath: resolveAdapterPath,
	});

	return {
		adapters: defaultMaterialized.adapters,
		blueprintModelId: undefined,
		blueprintName,
		blueprintSurfaces: [],
		blueprintUpgradePolicy: "rebuild_only",
		blueprintPath: undefined,
		writableRoots: resolveWritableRoots(args.cwd, cfg),
	};
}
