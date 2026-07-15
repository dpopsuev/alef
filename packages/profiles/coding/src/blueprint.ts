import { createAgentAdapter } from "@dpopsuev/alef-tool-agent";
import type { BlueprintStack, BlueprintStackOptions } from "@dpopsuev/alef-blueprint/registry";
import { blueprintRegistry } from "@dpopsuev/alef-blueprint/registry";
import {
	CODING_AGENT_BLUEPRINT,
	materializeBlueprint,
	materializeDefaultAdapters,
} from "@dpopsuev/alef-blueprint/materializer";
import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import { completeSimple } from "@dpopsuev/alef-ai/stream";
import { buildDelegationStack } from "@dpopsuev/alef-engine/delegation";
import { createSessionContextStage } from "@dpopsuev/alef-session/context";
import { createCompactionStage } from "@dpopsuev/alef-session/compaction";
import {
	applySessionMetadataRefresh,
	planThemeTagFromDesired,
	provisionalTitleFromText,
} from "@dpopsuev/alef-session/metadata";
import { createLlmSummarizer } from "@dpopsuev/alef-session/summarizer";
import type { SessionStore } from "@dpopsuev/alef-session/storage";
import { createServiceResolver, Supervisor } from "@dpopsuev/alef-supervisor/supervisor";

export type { BlueprintStack, BlueprintStackOptions };

/** Read-only explore slice — same SBOM as coding YAML, fs+web only. */
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
 * Coding stack: domain adapters come from the coding blueprint.yaml (via loadAdapters
 * or materializeDefaultAdapters). No peer adapter lists in this file.
 */
export async function createCodingAgentStack(opts: BlueprintStackOptions): Promise<BlueprintStack> {
	if (!opts.subagentFactory) {
		throw new Error("BlueprintStackOptions.subagentFactory is required.");
	}

	const supervisor = new Supervisor();
	const resolveService = createServiceResolver(supervisor);
	const materialiOpts = { cwd: opts.cwd, resolveService };

	const domainAdapters =
		opts.domainAdapters && opts.domainAdapters.length > 0
			? [...opts.domainAdapters]
			: await materializeDefaultAdapters(opts.cwd);

	const exploreAdapters = exploreSliceFrom(domainAdapters);
	const generalAdapters =
		opts.domainAdapters && opts.domainAdapters.length > 0
			? domainAdapters
			: (await materializeBlueprint(CODING_AGENT_BLUEPRINT, materialiOpts)).adapters;

	const { adapters, contextAssembly } = await buildDelegationStack({
		cwd: opts.cwd,
		factory: opts.subagentFactory,
		contextWindow: opts.model.contextWindow,
		getParentDirectives: opts.getParentDirectives,
		domainAdapters,
		exploreAdapters,
		generalAdapters,
		sessionStore: opts.sessionStore,
		writableRoots: opts.writableRoots,
		summarize: createLlmSummarizer((input) => completeSimple(opts.model, input)),
		compactionStrategy: (() => {
			const raw = process.env.ALEF_COMPACTION_STRATEGY;
			return raw === "shake" || raw === "off" || raw === "summarize" ? raw : "summarize";
		})(),
		adapters: { createAgentAdapter, createCompactionStage, createSessionContextStage },
		allowedBlueprints: blueprintRegistry.list(),
		materializeAdapters: async (names) => {
			const { adapters: materializedAdapters } = await materializeBlueprint(
				{
					...CODING_AGENT_BLUEPRINT,
					adapters: names.map((n) => ({ name: n, actions: [] as string[], toolNames: [] as string[] })),
				},
				materialiOpts,
			);
			return materializedAdapters;
		},
		onPlanOpened: (desired) => refreshMetadataOnPlanOpened(opts.sessionStore, desired),
		toolDisclosure: opts.toolDisclosure,
	});

	return { adapters, contextAssembly };
}
