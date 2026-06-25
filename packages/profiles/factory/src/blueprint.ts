import { createAgentAdapter, strategyRegistry } from "@dpopsuev/alef-adapter-agent";
import { createSkillsAdapter } from "@dpopsuev/alef-adapter-skills";
import { createWireAdapterWithFactory, type WireAdapterFactoryOptions } from "@dpopsuev/alef-adapter-workflow";
import type { BlueprintStack, BlueprintStackOptions } from "@dpopsuev/alef-agent-blueprint";
import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import { buildDelegationStack } from "@dpopsuev/alef-runtime";
import { createCompactionStage, createSessionContextStage } from "@dpopsuev/alef-session";

export type { BlueprintStack, BlueprintStackOptions };

export async function createFactoryAgentStack(opts: BlueprintStackOptions): Promise<BlueprintStack> {
	if (!opts.subagentFactory) {
		throw new Error("BlueprintStackOptions.subagentFactory is required.");
	}

	const skillsAdapter = createSkillsAdapter({ cwd: opts.cwd });

	const { adapters, pipeline, exploreAdapters, generalAdapters } = await buildDelegationStack({
		cwd: opts.cwd,
		factory: opts.subagentFactory,
		contextWindow: opts.model.contextWindow,
		domainAdapters: opts.domainAdapters,
		sessionStore: opts.sessionStore,
		writableRoots: opts.writableRoots,
		extraAdapters: [skillsAdapter],
		excludeNames: ["workflow"],
		adapters: { createAgentAdapter, strategyRegistry, createCompactionStage, createSessionContextStage },
	});

	const wireAdapter = createWireAdapterWithFactory({
		cwd: opts.cwd,
		subagentFactory: opts.subagentFactory as WireAdapterFactoryOptions["subagentFactory"],
		exploreAdapters,
		generalAdapters,
	});

	adapters.splice(adapters.length - 2, 0, wireAdapter as unknown as Adapter);

	return { adapters, pipeline };
}
