import { createAgentAdapter, strategyRegistry } from "@dpopsuev/alef-tool-agent";
import { createSkillsAdapter } from "@dpopsuev/alef-tool-skills";
import { createWireAdapterWithFactory, type WireAdapterFactoryOptions } from "@dpopsuev/alef-tool-workflow";
import type { BlueprintStack, BlueprintStackOptions } from "@dpopsuev/alef-blueprint";
import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import { buildDelegationStack } from "@dpopsuev/alef-runtime";
import { createSessionContextStage } from "@dpopsuev/alef-session/context";
import { createCompactionStage } from "@dpopsuev/alef-session/compaction";

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
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- subagentFactory satisfies WireAdapterFactoryOptions shape
		subagentFactory: opts.subagentFactory as WireAdapterFactoryOptions["subagentFactory"],
		exploreAdapters,
		generalAdapters,
	});

	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- wireAdapter conforms to Adapter but has narrower type
	adapters.splice(adapters.length - 2, 0, wireAdapter as unknown as Adapter);

	return { adapters, pipeline };
}
