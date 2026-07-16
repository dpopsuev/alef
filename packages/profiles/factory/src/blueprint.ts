import { createRequire } from "node:module";
import { createAgentAdapter } from "@dpopsuev/alef-tool-agent";
import { createWireAdapterWithFactory, type WireAdapterFactoryOptions } from "@dpopsuev/alef-tool-workflow";
import { loadAgentDefinition } from "@dpopsuev/alef-blueprint/blueprints";
import { resolveBootstrapBlueprintPath, type BootstrapBlueprintId } from "@dpopsuev/alef-blueprint/bootstrap";
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

export type { BlueprintStack, BlueprintStackOptions };

const require = createRequire(import.meta.url);

const STAFF_ROLE_PROFILES = [
	{
		profile: "gensec",
		blueprintId: "gensec" as BootstrapBlueprintId,
		role: { category: "staff", roleId: "gensec", blueprintId: "gensec" },
	},
	{
		profile: "2sec",
		blueprintId: "2sec" as BootstrapBlueprintId,
		role: { category: "staff", roleId: "2sec", blueprintId: "2sec" },
	},
] as const;

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

/** Read-only explore slice — fs+web when present on the domain set. */
function exploreSliceFrom(domain: readonly Adapter[]): Adapter[] {
	return domain.filter((a) => a.name === "fs" || a.name === "web");
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
 */
export async function createFactoryAgentStack(opts: BlueprintStackOptions): Promise<BlueprintStack> {
	if (!opts.subagentFactory) {
		throw new Error("BlueprintStackOptions.subagentFactory is required.");
	}

	const foundry = createFoundryRuntime({ cwd: opts.cwd });
	const definition = loadFactoryBlueprint();
	const staffRoleDefinitions = STAFF_ROLE_PROFILES.map((entry) => ({
		...entry,
		definition: loadAgentDefinition(resolveBootstrapBlueprintPath(entry.blueprintId)),
	}));

	const domainAdapters =
		opts.domainAdapters && opts.domainAdapters.length > 0
			? [...opts.domainAdapters]
			: (await foundry.materializeBlueprint(definition)).adapters;

	const exploreAdapters = exploreSliceFrom(domainAdapters);
	const generalAdapters = domainAdapters;

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
		profileRoles: Object.fromEntries(staffRoleDefinitions.map((entry) => [entry.profile, entry.role])),
		profilePrompts: staffRoleDefinitions.reduce<Record<string, string>>((profiles, entry) => {
			if (typeof entry.definition.systemPrompt === "string" && entry.definition.systemPrompt.length > 0) {
				profiles[entry.profile] = entry.definition.systemPrompt;
			}
			return profiles;
		}, {}),
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
		for (const role of staffRoleDefinitions) {
			agentAdapter.registerStrategy(role.profile, new InProcessStrategy(general, opts.subagentFactory, role.definition.systemPrompt));
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
