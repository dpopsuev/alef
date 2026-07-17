import { createRequire } from "node:module";
import { createAgentAdapter } from "@dpopsuev/alef-tool-agent";
import { createWireAdapterWithFactory, type WireAdapterFactoryOptions } from "@dpopsuev/alef-tool-workflow";
import { loadAgentDefinition } from "@dpopsuev/alef-blueprint/blueprints";
import { resolveBootstrapBlueprintPath } from "@dpopsuev/alef-blueprint/bootstrap";
import type { BlueprintStack, BlueprintStackOptions } from "@dpopsuev/alef-blueprint/registry";
import { blueprintRegistry } from "@dpopsuev/alef-blueprint/registry";
import { createFoundryRuntime } from "@dpopsuev/alef-foundry";
import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import { buildDelegationStack } from "@dpopsuev/alef-engine/delegation";
import { InProcessStrategy } from "@dpopsuev/alef-engine/in-process";
import { createSessionContextStage } from "@dpopsuev/alef-session/context";
import { createCompactionStage } from "@dpopsuev/alef-session/compaction";
import {
	applySessionMetadataRefresh,
	planThemeTagFromDesired,
	provisionalTitleFromText,
} from "@dpopsuev/alef-session/metadata";
import type { SessionStore } from "@dpopsuev/alef-session/storage";
import { loadFactoryLineRoles, STAFF_BOOTSTRAP_ROLES } from "./roles.js";

export type { BlueprintStack, BlueprintStackOptions };

const require = createRequire(import.meta.url);

/** Narrow adapters that support dynamic strategy registration. */
function isStrategyRegistrar(
	adapter: Adapter,
): adapter is Adapter & { registerStrategy(name: string, strategy: InProcessStrategy): void } {
	return "registerStrategy" in adapter && typeof adapter.registerStrategy === "function";
}

/** Load the factory profile SBOM from the published package export. */
function loadFactoryBlueprint() {
	return loadAgentDefinition(require.resolve("@dpopsuev/alef-factory-agent/blueprint"));
}

/** Load the coding profile SBOM for Worker strategies. */
function loadCodingBlueprint() {
	return loadAgentDefinition(require.resolve("@dpopsuev/alef-coding-agent/blueprint"));
}

/** Read-only explore slice — fs+web+code-intel when present on the domain set. */
function exploreSliceFrom(domain: readonly Adapter[]): Adapter[] {
	return domain.filter((a) => a.name === "fs" || a.name === "web" || a.name === "code-intel");
}

/** Policy A: retitle from plan.desired; merge prior tags with a theme tag. */
async function refreshMetadataOnPlanOpened(store: SessionStore | undefined, desired: string): Promise<void> {
	if (!store) return;
	const title = provisionalTitleFromText(desired);
	const theme = planThemeTagFromDesired(desired);
	await applySessionMetadataRefresh(store, {
		reason: "plan",
		title,
		tags: theme ? [theme] : undefined,
		mergeTags: true,
	});
}

/**
 * Factory stack — adapters come solely from factory blueprint.yaml (+ loadAdapters overlay).
 * Registers Coordinator/Director/Supervisor/Worker.* strategies plus legacy GenSec/2Sec.
 */
export async function createFactoryAgentStack(opts: BlueprintStackOptions): Promise<BlueprintStack> {
	if (!opts.subagentFactory) {
		throw new Error("BlueprintStackOptions.subagentFactory is required.");
	}

	const foundry = createFoundryRuntime({ cwd: opts.cwd });
	const definition = loadFactoryBlueprint();
	const lineRoles = loadFactoryLineRoles();
	const staffRoleDefinitions = STAFF_BOOTSTRAP_ROLES.map((entry) => ({
		...entry,
		kind: "staff" as const,
		codingTools: false,
		definition: loadAgentDefinition(resolveBootstrapBlueprintPath(entry.blueprintId)),
		systemPrompt: undefined as string | undefined,
	}));

	const domainAdapters =
		opts.domainAdapters && opts.domainAdapters.length > 0
			? [...opts.domainAdapters]
			: (await foundry.materializeBlueprint(definition)).adapters;

	const exploreAdapters = exploreSliceFrom(domainAdapters);
	const generalAdapters = domainAdapters;

	let codingAdapters: Adapter[] = generalAdapters;
	const needsCoding = lineRoles.some((role) => role.codingTools);
	if (needsCoding && !(opts.domainAdapters && opts.domainAdapters.length > 0)) {
		try {
			codingAdapters = (await foundry.materializeBlueprint(loadCodingBlueprint())).adapters;
		} catch {
			codingAdapters = generalAdapters;
		}
	}

	const profileRoles: Record<string, { category: string; roleId: string; blueprintId: string }> = {};
	const profilePrompts: Record<string, string> = {};

	for (const role of lineRoles) {
		profileRoles[role.profile] = role.role;
		profilePrompts[role.profile] = role.systemPrompt;
	}
	for (const entry of staffRoleDefinitions) {
		profileRoles[entry.profile] = entry.role;
		if (typeof entry.definition.systemPrompt === "string" && entry.definition.systemPrompt.length > 0) {
			profilePrompts[entry.profile] = entry.definition.systemPrompt;
		}
	}

	const { adapters, contextAssembly, exploreAdapters: explore, generalAdapters: general } = await buildDelegationStack({
		cwd: opts.cwd,
		factory: opts.subagentFactory,
		contextWindow: opts.model.contextWindow,
		getParentDirectives: opts.getParentDirectives,
		domainAdapters,
		exploreAdapters,
		generalAdapters,
		sessionStore: opts.sessionStore,
		writableRoots: opts.writableRoots,
		excludeNames: ["workflow"],
		adapters: { createAgentAdapter, createCompactionStage, createSessionContextStage },
		allowedBlueprints: blueprintRegistry.list(),
		profileRoles,
		profilePrompts,
		materializeAdapters: async (names) => {
			const { adapters: materializedAdapters } = await foundry.materializeBlueprint(
				{
					...definition,
					adapters: names.map((n) => ({ name: n, actions: [] as string[], toolNames: [] as string[] })),
				},
			);
			return materializedAdapters;
		},
		onPlanOpened: (desired) => refreshMetadataOnPlanOpened(opts.sessionStore, desired),
	});

	const agentAdapter = adapters.find((adapter) => adapter.name === "agent");
	if (agentAdapter && isStrategyRegistrar(agentAdapter)) {
		for (const role of lineRoles) {
			const toolset = role.codingTools ? codingAdapters : general;
			agentAdapter.registerStrategy(role.profile, new InProcessStrategy(toolset, opts.subagentFactory, role.systemPrompt));
		}
		for (const entry of staffRoleDefinitions) {
			agentAdapter.registerStrategy(
				entry.profile,
				new InProcessStrategy(general, opts.subagentFactory, entry.definition.systemPrompt),
			);
		}
	}

	const wireAdapter = createWireAdapterWithFactory({
		cwd: opts.cwd,
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- subagentFactory satisfies WireAdapterFactoryOptions shape
		subagentFactory: opts.subagentFactory as WireAdapterFactoryOptions["subagentFactory"],
		exploreAdapters: explore,
		generalAdapters: general,
	});

	adapters.splice(adapters.length - 2, 0, wireAdapter);

	return { adapters, contextAssembly };
}
