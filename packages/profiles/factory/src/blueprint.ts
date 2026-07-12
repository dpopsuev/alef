import { createAgentAdapter } from "@dpopsuev/alef-tool-agent";
import { createSkillsAdapter } from "@dpopsuev/alef-tool-skills";
import { createWireAdapterWithFactory, type WireAdapterFactoryOptions } from "@dpopsuev/alef-tool-workflow";
import type { BlueprintStack, BlueprintStackOptions } from "@dpopsuev/alef-blueprint/registry";
import { blueprintRegistry } from "@dpopsuev/alef-blueprint/registry";
import {
	DEFAULT_COMPILED_DEFINITION,
	materializeBlueprint,
	materializeDefaultAdapters,
} from "@dpopsuev/alef-blueprint/materializer";
import type { CompiledAgentAdapterDefinition } from "@dpopsuev/alef-blueprint/types";
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import { buildDelegationStack } from "@dpopsuev/alef-engine/delegation";
import { createSessionContextStage } from "@dpopsuev/alef-session/context";
import { createCompactionStage } from "@dpopsuev/alef-session/compaction";
import { createServiceResolver, Supervisor } from "@dpopsuev/alef-supervisor/supervisor";

export type { BlueprintStack, BlueprintStackOptions };

const DEFAULT_EXPLORE_ADAPTERS: CompiledAgentAdapterDefinition[] = [
	{ name: "fs", actions: [], toolNames: ["fs.read", "fs.grep", "fs.find"] },
	{ name: "web", actions: [], toolNames: [] },
];

/**
 *
 */
export async function createFactoryAgentStack(opts: BlueprintStackOptions): Promise<BlueprintStack> {
	if (!opts.subagentFactory) {
		throw new Error("BlueprintStackOptions.subagentFactory is required.");
	}

	const skillsAdapter = createSkillsAdapter({ cwd: opts.cwd });

	const supervisor = new Supervisor();
	const resolveService = createServiceResolver(supervisor);
	const materialiOpts = { cwd: opts.cwd, resolveService };

	const [domainAdapters, { adapters: exploreAdapters }, { adapters: generalAdapters }] = await Promise.all([
		opts.domainAdapters ? Promise.resolve([...opts.domainAdapters]) : materializeDefaultAdapters(opts.cwd),
		materializeBlueprint({ ...DEFAULT_COMPILED_DEFINITION, adapters: [...DEFAULT_EXPLORE_ADAPTERS] }, materialiOpts),
		materializeBlueprint(DEFAULT_COMPILED_DEFINITION, materialiOpts),
	]);

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
		extraAdapters: [skillsAdapter],
		excludeNames: ["workflow"],
		adapters: { createAgentAdapter, createCompactionStage, createSessionContextStage },
		allowedBlueprints: blueprintRegistry.list(),
		materializeAdapters: async (names) => {
			const { adapters: materializedAdapters } = await materializeBlueprint(
				{
					...DEFAULT_COMPILED_DEFINITION,
					adapters: names.map((n) => ({ name: n, actions: [] as string[], toolNames: [] as string[] })),
				},
				materialiOpts,
			);
			return materializedAdapters;
		},
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
