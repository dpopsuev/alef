import { createAgentAdapter, strategyRegistry } from "@dpopsuev/alef-tool-agent";
import { createFactoryAdapter } from "@dpopsuev/alef-tool-factory";
import { createSkillsAdapter } from "@dpopsuev/alef-tool-skills";
import type { BlueprintStack, BlueprintStackOptions } from "@dpopsuev/alef-blueprint/registry";
import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import { buildDelegationStack } from "@dpopsuev/alef-engine/delegation";
import { createSessionContextStage } from "@dpopsuev/alef-session/context";
import { createCompactionStage } from "@dpopsuev/alef-session/compaction";
import { createLlmSummarizer } from "@dpopsuev/alef-session/summarizer";
import { createServiceResolver, Supervisor } from "@dpopsuev/alef-supervisor/supervisor";

export type { BlueprintStack, BlueprintStackOptions };

export async function createCodingAgentStack(opts: BlueprintStackOptions): Promise<BlueprintStack> {
	if (!opts.subagentFactory) {
		throw new Error("BlueprintStackOptions.subagentFactory is required.");
	}

	const skillsAdapter = createSkillsAdapter({ cwd: opts.cwd });
	const factoryAdapter = createFactoryAdapter({ cwd: opts.cwd });

	const supervisor = new Supervisor();
	const resolveService = createServiceResolver(supervisor);

	const { adapters, pipeline } = await buildDelegationStack({
		cwd: opts.cwd,
		factory: opts.subagentFactory,
		contextWindow: opts.model.contextWindow,
		domainAdapters: opts.domainAdapters,
		sessionStore: opts.sessionStore,
		writableRoots: opts.writableRoots,
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- factoryAdapter conforms to Adapter but has narrower type
		extraAdapters: [skillsAdapter, factoryAdapter as unknown as Adapter],
		summarize: createLlmSummarizer(opts.model),
		adapters: { createAgentAdapter, strategyRegistry, createCompactionStage, createSessionContextStage },
		resolveService,
	});

	return { adapters, pipeline };
}
