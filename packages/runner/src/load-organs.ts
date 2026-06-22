import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { AgentDefinitionSurfaceInput } from "@dpopsuev/alef-agent-blueprint";
import {
	DEFAULT_COMPILED_DEFINITION,
	findAgentDefinitionPath,
	loadAgentDefinition,
	loadUserOrgansConfig,
	materializeBlueprint,
	mergeAgentDefinitions,
} from "@dpopsuev/alef-agent-blueprint";
import type { Organ } from "@dpopsuev/alef-kernel";
import type { Logger } from "pino";
import type { Args } from "./args.js";
import { discoverBlueprints, pickBlueprint, resolveBlueprint } from "./blueprint-picker.js";
import type { AlefConfig } from "./config.js";

/**
 * Resolve writable_roots from config (or inherited env var), substituting placeholders.
 * Returns undefined = unrestricted (no guard).
 *
 * Resolution order:
 *   1. config.security.writable_roots (explicit user config)
 *   2. ALEF_WRITABLE_ROOTS env var (propagated from parent via orchestration.spawn)
 *   3. undefined (unrestricted — pi-mono style default)
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
			const parsed = JSON.parse(envRoots) as string[];
			if (Array.isArray(parsed)) return parsed.map((r) => resolve(r));
		} catch {
			/* malformed — treat as unrestricted */
		}
	}
	return undefined;
}

export interface LoadResult {
	organs: Organ[];
	blueprintModelId: string | undefined;
	blueprintName: string | undefined;
	blueprintSurfaces: AgentDefinitionSurfaceInput[];
	blueprintUpgradePolicy: "rebuild_only" | "packages" | "self";
	blueprintPath: string | undefined;
	writableRoots: readonly string[] | undefined;
}

export async function loadOrgans(args: Args, cfg: AlefConfig, log: Logger): Promise<LoadResult> {
	let blueprintPath: string | undefined;
	let blueprintName: string | undefined;

	if (args.blueprint) {
		blueprintPath = resolveBlueprint(args.blueprint, args.cwd) ?? args.blueprint;
		blueprintName = args.blueprint;
	} else if (!args.print && !args.json && process.stdin.isTTY) {
		const discovered = discoverBlueprints(args.cwd);
		if (discovered.length > 1) {
			const chosen = await pickBlueprint(discovered);
			if (chosen) {
				blueprintPath = chosen.path;
				blueprintName = chosen.name;
				log.info({ blueprint: chosen.name, path: chosen.path }, "blueprint:selected");
			}
		}
	}

	const isExplicitBlueprint = !!blueprintPath;
	if (!blueprintPath) {
		blueprintPath = findAgentDefinitionPath(args.cwd);
	}

	if (blueprintPath) {
		const { existsSync } = await import("node:fs");

		if (!existsSync(blueprintPath)) {
			const looksLikePath =
				blueprintPath.includes("/") || blueprintPath.endsWith(".yaml") || blueprintPath.endsWith(".yml");
			if (looksLikePath) {
				throw new Error(`Blueprint file not found: ${blueprintPath}`);
			}
			return {
				organs: [],
				blueprintModelId: undefined,
				blueprintName,
				blueprintSurfaces: [],
				blueprintUpgradePolicy: "rebuild_only",
				blueprintPath: undefined,
				writableRoots: resolveWritableRoots(args.cwd, cfg),
			};
		}

		let definition = isExplicitBlueprint
			? loadAgentDefinition(blueprintPath)
			: mergeAgentDefinitions(DEFAULT_COMPILED_DEFINITION, loadAgentDefinition(blueprintPath));

		if (args.profile) {
			const { dirname: pathDirname, join: pathJoin } = await import("node:path");
			const { existsSync: fsExistsSync } = await import("node:fs");
			const baseDir = definition.baseDir ?? pathDirname(blueprintPath);
			const overlayPath = pathJoin(baseDir, `agent.${args.profile}.yaml`);
			if (fsExistsSync(overlayPath)) {
				const overlay = loadAgentDefinition(overlayPath);
				definition = mergeAgentDefinitions(definition, overlay);
			} else {
				console.error(`[alef] Profile overlay not found: ${overlayPath} (continuing without it)`);
			}
		}

		const materialized = await materializeBlueprint(definition, {
			cwd: args.cwd,
			loggerFor: (name) => log.child({ organ: name }),
			allowedTools: args.yolo ? ["*"] : cfg.permissions?.allowed_tools,
			writableRoots: resolveWritableRoots(args.cwd, cfg),
		});

		return {
			organs: materialized.organs,
			blueprintModelId: materialized.modelId,
			blueprintName: blueprintName ?? definition.name,
			blueprintSurfaces: definition.surfaces,
			blueprintUpgradePolicy: definition.supervisor?.upgradePolicy ?? "rebuild_only",
			blueprintPath,
			writableRoots: resolveWritableRoots(args.cwd, cfg),
		};
	}

	const userOrgans = loadUserOrgansConfig();
	const definition = userOrgans ? { ...DEFAULT_COMPILED_DEFINITION, organs: userOrgans } : DEFAULT_COMPILED_DEFINITION;
	if (userOrgans) log.info({ count: userOrgans.length }, "loaded user organs config");
	const defaultMaterialized = await materializeBlueprint(definition, {
		cwd: args.cwd,
		loggerFor: (name) => log.child({ organ: name }),
		allowedTools: args.yolo ? ["*"] : cfg.permissions?.allowed_tools,
		writableRoots: resolveWritableRoots(args.cwd, cfg),
	});

	return {
		organs: defaultMaterialized.organs,
		blueprintModelId: undefined,
		blueprintName: undefined,
		blueprintSurfaces: [],
		blueprintUpgradePolicy: "rebuild_only",
		blueprintPath: undefined,
		writableRoots: resolveWritableRoots(args.cwd, cfg),
	};
}
