import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
	findAgentDefinitionPath,
	loadAgentDefinition,
	mergeAgentDefinitions,
} from "@dpopsuev/alef-blueprint/blueprints";
import {
	DEFAULT_COMPILED_DEFINITION,
	loadUserAdaptersConfig,
	materializeBlueprint,
} from "@dpopsuev/alef-blueprint/materializer";
import type { AgentDefinitionSurfaceInput } from "@dpopsuev/alef-blueprint/types";
import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import type { Logger } from "pino";
import { discoverBlueprints, pickBlueprint, resolveBlueprint } from "../client/blueprints.js";
import type { Args } from "./args.js";
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
			const parsed: unknown = JSON.parse(envRoots);
			if (Array.isArray(parsed)) return (parsed as string[]).map((r) => resolve(r)); // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- Array.isArray narrows; elements are strings by convention
		} catch {
			/* malformed — treat as unrestricted */
		}
	}
	return undefined;
}

export interface AdapterLoadResult {
	adapters: Adapter[];
	blueprintModelId: string | undefined;
	blueprintName: string | undefined;
	blueprintSurfaces: AgentDefinitionSurfaceInput[];
	blueprintUpgradePolicy: "rebuild_only" | "packages" | "self";
	blueprintPath: string | undefined;
	writableRoots: readonly string[] | undefined;
}

export async function loadAdapters(
	args: Args,
	cfg: AlefConfig,
	log: Logger,
	sessionDir?: string,
): Promise<AdapterLoadResult> {
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
	blueprintPath ??= findAgentDefinitionPath(args.cwd);

	if (blueprintPath) {
		const { existsSync } = await import("node:fs");

		if (!existsSync(blueprintPath)) {
			const looksLikePath =
				blueprintPath.includes("/") || blueprintPath.endsWith(".yaml") || blueprintPath.endsWith(".yml");
			if (looksLikePath) {
				throw new Error(`Blueprint file not found: ${blueprintPath}`);
			}
			return {
				adapters: [],
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
			sessionDir,
			loggerFor: (name) => log.child({ adapter: name }),
			allowedTools: args.yolo ? ["*"] : cfg.permissions?.allowed_tools,
			writableRoots: resolveWritableRoots(args.cwd, cfg),
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

	const userAdapters = loadUserAdaptersConfig();
	const definition = userAdapters
		? { ...DEFAULT_COMPILED_DEFINITION, adapters: userAdapters }
		: DEFAULT_COMPILED_DEFINITION;
	if (userAdapters) log.info({ count: userAdapters.length }, "loaded user adapters config");
	const defaultMaterialized = await materializeBlueprint(definition, {
		cwd: args.cwd,
		sessionDir,
		loggerFor: (name) => log.child({ adapter: name }),
		allowedTools: args.yolo ? ["*"] : cfg.permissions?.allowed_tools,
		writableRoots: resolveWritableRoots(args.cwd, cfg),
	});

	return {
		adapters: defaultMaterialized.adapters,
		blueprintModelId: undefined,
		blueprintName: undefined,
		blueprintSurfaces: [],
		blueprintUpgradePolicy: "rebuild_only",
		blueprintPath: undefined,
		writableRoots: resolveWritableRoots(args.cwd, cfg),
	};
}
