import type { AgentDefinitionSurfaceInput } from "@dpopsuev/alef-agent-blueprint";
import { findAgentDefinitionPath, loadAgentDefinition, mergeAgentDefinitions } from "@dpopsuev/alef-agent-blueprint";
import type { Organ } from "@dpopsuev/alef-kernel";
import type { Logger } from "pino";
import type { Args } from "./args.js";
import type { AlefConfig } from "./config.js";
import { DEFAULT_COMPILED_DEFINITION, loadUserOrgansConfig, materializeBlueprint } from "@dpopsuev/alef-agent-blueprint";

export interface LoadResult {
	organs: Organ[];
	blueprintModelId: string | undefined;
	blueprintSurfaces: AgentDefinitionSurfaceInput[];
	blueprintUpgradePolicy: "rebuild_only" | "packages" | "self";
	blueprintPath: string | undefined;
}

export async function loadOrgans(args: Args, cfg: AlefConfig, log: Logger): Promise<LoadResult> {
	const blueprintPath = args.blueprint ?? findAgentDefinitionPath(args.cwd);

	if (blueprintPath) {
		let definition = loadAgentDefinition(blueprintPath);

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
		});

		return {
			organs: materialized.organs,
			blueprintModelId: materialized.modelId,
			blueprintSurfaces: definition.surfaces,
			blueprintUpgradePolicy: definition.supervisor?.upgradePolicy ?? "rebuild_only",
			blueprintPath,
		};
	}

	const userOrgans = loadUserOrgansConfig();
	const definition = userOrgans ? { ...DEFAULT_COMPILED_DEFINITION, organs: userOrgans } : DEFAULT_COMPILED_DEFINITION;
	if (userOrgans) log.info({ count: userOrgans.length }, "loaded user organs config");
	const defaultMaterialized = await materializeBlueprint(definition, {
		cwd: args.cwd,
		loggerFor: (name) => log.child({ organ: name }),
		allowedTools: args.yolo ? ["*"] : cfg.permissions?.allowed_tools,
	});

	return {
		organs: defaultMaterialized.organs,
		blueprintModelId: undefined,
		blueprintSurfaces: [],
		blueprintUpgradePolicy: "rebuild_only",
		blueprintPath: undefined,
	};
}
