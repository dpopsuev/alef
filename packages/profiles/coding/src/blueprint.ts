import { createAgentAdapter, strategyRegistry } from "@dpopsuev/alef-tool-agent";
import { createFactoryAdapter } from "@dpopsuev/alef-tool-factory";
import { createSkillsAdapter } from "@dpopsuev/alef-tool-skills";
import type { BlueprintStack, BlueprintStackOptions } from "@dpopsuev/alef-blueprint";
import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import { buildDelegationStack } from "@dpopsuev/alef-runtime";
import { createCompactionStage, createLlmSummarizer, createSessionContextStage } from "@dpopsuev/alef-session";

export type { BlueprintStack, BlueprintStackOptions };

export async function createCodingAgentStack(opts: BlueprintStackOptions): Promise<BlueprintStack> {
	if (!opts.subagentFactory) {
		throw new Error("BlueprintStackOptions.subagentFactory is required.");
	}

	const skillsAdapter = createSkillsAdapter({ cwd: opts.cwd });
	const factoryAdapter = createFactoryAdapter({ cwd: opts.cwd });

	const { adapters, pipeline } = await buildDelegationStack({
		cwd: opts.cwd,
		factory: opts.subagentFactory,
		contextWindow: opts.model.contextWindow,
		domainAdapters: opts.domainAdapters,
		sessionStore: opts.sessionStore,
		writableRoots: opts.writableRoots,
		extraAdapters: [skillsAdapter, factoryAdapter as unknown as Adapter],
		summarize: createLlmSummarizer(opts.model),
		adapters: { createAgentAdapter, strategyRegistry, createCompactionStage, createSessionContextStage },
	});

	return { adapters, pipeline };
}
