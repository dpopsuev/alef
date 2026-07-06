import { createAgentAdapter } from "@dpopsuev/alef-tool-agent";
import { createSkillsAdapter } from "@dpopsuev/alef-tool-skills";
import { createWireAdapterWithFactory, type WireAdapterFactoryOptions } from "@dpopsuev/alef-tool-workflow";
import type { BlueprintStack, BlueprintStackOptions } from "@dpopsuev/alef-blueprint/registry";
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import { buildDelegationStack } from "@dpopsuev/alef-engine/delegation";
import { createSessionContextStage } from "@dpopsuev/alef-session/context";
import { createCompactionStage } from "@dpopsuev/alef-session/compaction";
import { createServiceResolver, Supervisor } from "@dpopsuev/alef-supervisor/supervisor";

export type { BlueprintStack, BlueprintStackOptions };

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

	const { adapters, contextAssembly, exploreAdapters, generalAdapters } = await buildDelegationStack({
		cwd: opts.cwd,
		factory: opts.subagentFactory,
		contextWindow: opts.model.contextWindow,
		domainAdapters: opts.domainAdapters,
		sessionStore: opts.sessionStore,
		writableRoots: opts.writableRoots,
		extraAdapters: [skillsAdapter],
		excludeNames: ["workflow"],
		adapters: { createAgentAdapter, createCompactionStage, createSessionContextStage },
		resolveService,
	});

	const wireAdapter = createWireAdapterWithFactory({
		cwd: opts.cwd,
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- subagentFactory satisfies WireAdapterFactoryOptions shape
		subagentFactory: opts.subagentFactory as WireAdapterFactoryOptions["subagentFactory"],
		exploreAdapters,
		generalAdapters,
	});

	 
	adapters.splice(adapters.length - 2, 0, wireAdapter);

	return { adapters, contextAssembly };
}
