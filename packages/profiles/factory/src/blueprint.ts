import { createRequire } from "node:module";
import { createAgentAdapter } from "@dpopsuev/alef-tool-agent";
import { createWireAdapterWithFactory, type WireAdapterFactoryOptions } from "@dpopsuev/alef-tool-workflow";
import { loadAgentDefinition } from "@dpopsuev/alef-blueprint/blueprints";
import type { BlueprintStack, BlueprintStackOptions } from "@dpopsuev/alef-blueprint/registry";
import { blueprintRegistry } from "@dpopsuev/alef-blueprint/registry";
import { materializeBlueprint } from "@dpopsuev/alef-blueprint/materializer";
import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import { buildDelegationStack } from "@dpopsuev/alef-engine/delegation";
import { createSessionContextStage } from "@dpopsuev/alef-session/context";
import { createCompactionStage } from "@dpopsuev/alef-session/compaction";
import {
	applySessionMetadataRefresh,
	planThemeTagFromDesired,
	provisionalTitleFromText,
} from "@dpopsuev/alef-session/metadata";
import type { SessionStore } from "@dpopsuev/alef-session/storage";
import { createServiceResolver, Supervisor } from "@dpopsuev/alef-supervisor/supervisor";

export type { BlueprintStack, BlueprintStackOptions };

const require = createRequire(import.meta.url);

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

	const supervisor = new Supervisor();
	const resolveService = createServiceResolver(supervisor);
	const materialiOpts = { cwd: opts.cwd, resolveService };
	const definition = loadFactoryBlueprint();

	const domainAdapters =
		opts.domainAdapters && opts.domainAdapters.length > 0
			? [...opts.domainAdapters]
			: (await materializeBlueprint(definition, materialiOpts)).adapters;

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
		materializeAdapters: async (names) => {
			const { adapters: materializedAdapters } = await materializeBlueprint(
				{
					...definition,
					adapters: names.map((n) => ({ name: n, actions: [] as string[], toolNames: [] as string[] })),
				},
				materialiOpts,
			);
			return materializedAdapters;
		},
		onPlanOpened: (desired) => refreshMetadataOnPlanOpened(opts.sessionStore, desired),
	});

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
