import type { CompiledAgentAdapterDefinition, SubagentFactory } from "@dpopsuev/alef-blueprint";
import {
	blueprintRegistry,
	DEFAULT_COMPILED_DEFINITION,
	materializeBlueprint,
	materializeDefaultAdapters,
} from "@dpopsuev/alef-blueprint";
import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import { createContextAssemblyPipeline } from "@dpopsuev/alef-kernel/pipeline";
import { buildAdapterDirectives, createToolShellAdapter, InProcessStrategy } from "@dpopsuev/alef-engine";

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

export interface DelegationAdapters {
	createAgentAdapter: (opts: Record<string, unknown>) => Adapter;
	strategyRegistry: { register(name: string, strategy: unknown): void };
	// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
	createCompactionStage: Function;
	// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
	createSessionContextStage: Function;
}

export interface DelegationStackOptions {
	cwd: string;
	factory: SubagentFactory;
	contextWindow: number;
	domainAdapters?: readonly Adapter[];
	sessionStore?: unknown;
	writableRoots?: readonly string[];
	exploreAdapterDefs?: CompiledAgentAdapterDefinition[];
	explorePrompt?: string;
	generalPrompt?: string;
	extraAdapters?: Adapter[];
	excludeNames?: string[];
	summarize?: (messages: readonly unknown[]) => Promise<string>;
	adapters: DelegationAdapters;
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
		adapters: injected,
	} = opts;
	const materialiOpts = { cwd };

	const [resolvedDomainAdapters, { adapters: exploreAdapters }, { adapters: generalAdapters }] = await Promise.all([
		opts.domainAdapters ? Promise.resolve([...opts.domainAdapters]) : materializeDefaultAdapters(cwd),
		materializeBlueprint({ ...DEFAULT_COMPILED_DEFINITION, adapters: [...exploreAdapterDefs] }, materialiOpts),
		materializeBlueprint(DEFAULT_COMPILED_DEFINITION, materialiOpts),
	]);

	const pipeline = createContextAssemblyPipeline();

	const allWeights: Record<string, number> = {};
	for (const adapter of [...resolvedDomainAdapters, ...extraAdapters]) {
		const w = adapter.contributions?.["event.weights"];
		if (w) Object.assign(allWeights, w);
	}
	if (Object.keys(allWeights).length > 0) {
		const { registerEventWeights } = await import("@dpopsuev/alef-session/scoring");
		registerEventWeights(allWeights);
	}

	if (opts.sessionStore) {
		const store = opts.sessionStore;
		// eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call
		pipeline.addStage("memory", injected.createSessionContextStage({ sessionStore: () => store, contextWindow }));
	}

	const exploreStrategy = new InProcessStrategy(exploreAdapters, factory, explorePrompt);
	const generalStrategy = new InProcessStrategy(generalAdapters, factory, generalPrompt);
	injected.strategyRegistry.register("explore", exploreStrategy);
	injected.strategyRegistry.register("general", generalStrategy);

	const parentAdapterNames = new Set(resolvedDomainAdapters.map((a: Adapter) => a.name));
	const agentAdapter = injected.createAgentAdapter({
		cwd,
		strategies: { explore: exploreStrategy, general: generalStrategy },
		replyEvent: "llm.response",
		writableRoots: opts.writableRoots,
		parentAdapterNames,
		allowedBlueprints: blueprintRegistry.list(),
		materializeAdapters: async (names: string[]) => {
			const allowed = names.filter((n: string) => parentAdapterNames.has(n));
			const { adapters: materializedAdapters } = await materializeBlueprint(
				{
					...DEFAULT_COMPILED_DEFINITION,
					adapters: allowed.map((n: string) => ({ name: n, actions: [] as string[], toolNames: [] as string[] })),
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
		// eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call
		injected.createCompactionStage({
			contextWindow,
			summarize: opts.summarize,
			publishSignal: (type: string, payload: Record<string, unknown>) => signalPublish?.(type, payload),
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
	const filteredDomain = resolvedDomainAdapters.filter((o: Adapter) => !baseExclude.has(o.name));
	const allAdapters = [...filteredDomain, ...extraAdapters, agentAdapter];
	const toolShell = createToolShellAdapter({
		tools: allAdapters.flatMap((o: Adapter) => o.tools),
		getTools: () => allAdapters.flatMap((o: Adapter) => o.tools),
		adapterDirectives: buildAdapterDirectives(allAdapters),
	});

	const adapters: Adapter[] = [...allAdapters, toolShell, pipeline];

	return { adapters, pipeline, exploreAdapters, generalAdapters };
}
