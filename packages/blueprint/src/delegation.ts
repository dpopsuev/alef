import { createAgentAdapter, strategyRegistry } from "@dpopsuev/alef-adapter-agent";
import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import { createContextAssemblyPipeline } from "@dpopsuev/alef-kernel/pipeline";
import { buildAdapterDirectives, createToolShellAdapter, InProcessStrategy } from "@dpopsuev/alef-runtime";
import { createCompactionStage, createSessionContextStage } from "@dpopsuev/alef-session";
import { DEFAULT_COMPILED_DEFINITION, materializeBlueprint, materializeDefaultAdapters } from "./materializer.js";
import type { SubagentFactory } from "./registry.js";
import type { CompiledAgentAdapterDefinition } from "./types.js";

const EXPLORE_SYSTEM_PROMPT = `Read-only exploration agent. Read files, search code, fetch URLs, report findings.
NEVER write files. NEVER modify state. NEVER execute commands that change anything.
NEVER use emojis. Start with the finding. No filler, no preamble.
Read files before describing them. Batch parallel reads.
Your response IS the return value — factual, structured, under 500 words.`;

const GENERAL_SYSTEM_PROMPT = `General-purpose Alef subagent.
NEVER create files for research, analysis, summaries, or reports. Report in chat as prose.
NEVER use emojis. No filler. No preamble. Start with the finding.
NEVER use git commit --no-verify or skip pre-commit hooks.
ALWAYS read a file with fs.read before editing it with fs.edit.
ALWAYS call tools.describe(["tool-name"]) before first use of any tool.
Batch parallel reads. Answer the question first.`;

const DEFAULT_EXPLORE_ADAPTERS: CompiledAgentAdapterDefinition[] = [
	{ name: "fs", actions: [], toolNames: ["fs.read", "fs.grep", "fs.find"] },
	{ name: "web", actions: [], toolNames: [] },
];

export interface DelegationStackOptions {
	cwd: string;
	factory: SubagentFactory;
	contextWindow: number;
	domainAdapters?: readonly Adapter[];
	sessionStore?: Parameters<typeof createSessionContextStage>[0]["sessionStore"] extends () => infer S ? S : never;
	writableRoots?: readonly string[];
	exploreAdapterDefs?: CompiledAgentAdapterDefinition[];
	explorePrompt?: string;
	generalPrompt?: string;
	extraAdapters?: Adapter[];
	excludeNames?: string[];
	summarize?: (messages: readonly unknown[]) => Promise<string>;
}

export interface DelegationStack {
	adapters: Adapter[];
	pipeline: ReturnType<typeof createContextAssemblyPipeline>;
	exploreAdapters: Adapter[];
	generalAdapters: Adapter[];
}

export async function buildDelegationStack(opts: DelegationStackOptions): Promise<DelegationStack> {
	const {
		cwd,
		factory,
		contextWindow,
		exploreAdapterDefs = DEFAULT_EXPLORE_ADAPTERS,
		explorePrompt = EXPLORE_SYSTEM_PROMPT,
		generalPrompt = GENERAL_SYSTEM_PROMPT,
		extraAdapters = [],
		excludeNames = [],
	} = opts;
	const materialiOpts = { cwd };

	const [resolvedDomainAdapters, { adapters: exploreAdapters }, { adapters: generalAdapters }] = await Promise.all([
		opts.domainAdapters ? Promise.resolve([...opts.domainAdapters]) : materializeDefaultAdapters(cwd),
		materializeBlueprint({ ...DEFAULT_COMPILED_DEFINITION, adapters: [...exploreAdapterDefs] }, materialiOpts),
		materializeBlueprint(DEFAULT_COMPILED_DEFINITION, materialiOpts),
	]);

	const pipeline = createContextAssemblyPipeline();

	if (opts.sessionStore) {
		const store = opts.sessionStore;
		pipeline.addStage("memory", createSessionContextStage({ sessionStore: () => store, contextWindow }));
	}

	const exploreStrategy = new InProcessStrategy(exploreAdapters, factory, explorePrompt);
	const generalStrategy = new InProcessStrategy(generalAdapters, factory, generalPrompt);
	strategyRegistry.register("explore", exploreStrategy);
	strategyRegistry.register("general", generalStrategy);

	const agentAdapter = createAgentAdapter({
		cwd,
		strategies: { explore: exploreStrategy, general: generalStrategy },
		replyEvent: "llm.response",
		writableRoots: opts.writableRoots,
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
		subagentFactory: factory,
	});

	let signalPublish: ((type: string, payload: Record<string, unknown>) => void) | undefined;
	let lastTotalTokens = 0;
	pipeline.addStage(
		"compactor",
		createCompactionStage({
			contextWindow,
			summarize: opts.summarize,
			publishSignal: (type, payload) => signalPublish?.(type, payload),
			getLastTokenCount: () => lastTotalTokens,
		}),
	);
	const origMount = pipeline.mount.bind(pipeline);
	(pipeline as { mount: typeof pipeline.mount }).mount = (bus) => {
		signalPublish = (type, payload) => bus.notification.publish({ type, payload, correlationId: "" });
		bus.notification.subscribe("llm.token-usage", (event) => {
			const usage = (event as { payload?: { usage?: { totalTokens?: number } } }).payload?.usage;
			if (usage?.totalTokens) lastTotalTokens = usage.totalTokens;
		});
		return origMount(bus);
	};

	const baseExclude = new Set(["agent", "factory", "skills", "compactor", ...excludeNames]);
	const filteredDomain = resolvedDomainAdapters.filter((o) => !baseExclude.has(o.name));
	const allAdapters = [...filteredDomain, ...extraAdapters, agentAdapter as unknown as Adapter];
	const toolShell = createToolShellAdapter({
		tools: allAdapters.flatMap((o) => o.tools),
		getTools: () => allAdapters.flatMap((o) => o.tools),
		adapterDirectives: buildAdapterDirectives(allAdapters),
	});

	const adapters: Adapter[] = [...allAdapters, toolShell, pipeline as unknown as Adapter];

	return { adapters, pipeline, exploreAdapters, generalAdapters };
}
