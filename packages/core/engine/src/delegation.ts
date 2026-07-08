/**
 * Delegation stack builder — materializes adapters, creates explore/general
 * strategies, and wires the context assembly contextAssembly.
 *
 * Used by blueprint profiles (coding, factory) to build the full adapter stack.
 */

import type { AdapterFactoryOptions } from "@dpopsuev/alef-blueprint/materializer";
import type { CompiledAgentAdapterDefinition } from "@dpopsuev/alef-blueprint/types";
import type { SubagentFactory } from "@dpopsuev/alef-blueprint/registry";
import { blueprintRegistry } from "@dpopsuev/alef-blueprint/registry";
import {
	DEFAULT_COMPILED_DEFINITION,
	materializeBlueprint,
	materializeDefaultAdapters,
} from "@dpopsuev/alef-blueprint/materializer";
import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import type { ContextAssemblyHandler } from "@dpopsuev/alef-kernel/contributions";
import { createContextAssembler } from "@dpopsuev/alef-kernel/context-assembly";
import { buildAdapterDirectives, createToolShellAdapter } from "./tool-catalog.js";
import { InProcessStrategy } from "./in-process.js";

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

/** Injected factory functions the delegation stack uses to create cross-cutting adapters. */
export interface DelegationAdapters {
	createAgentAdapter: (opts: Record<string, unknown>) => Adapter;
	strategyRegistry?: { register(name: string, strategy: unknown): void };
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- engine can't import session types (DIP boundary)
	createCompactionStage: (opts?: any) => ContextAssemblyHandler;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- engine can't import session types (DIP boundary)
	createSessionContextStage: (opts: any) => ContextAssemblyHandler;
}

/** Configuration for building explore/general strategies, context assembly, and domain adapters. */
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
	resolveService?: (service: unknown, opts: AdapterFactoryOptions) => Promise<readonly Adapter[] | undefined>;
}

/** Materialized adapter set with explore/general strategies and context assembly pipeline. */
export interface DelegationStack {
	adapters: Adapter[];
	contextAssembly: ReturnType<typeof createContextAssembler>;
	exploreAdapters: Adapter[];
	generalAdapters: Adapter[];
}

/** Materialize adapters, wire explore/general strategies, and assemble the context pipeline. */
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
	const materialiOpts = { cwd, resolveService: opts.resolveService };

	const [resolvedDomainAdapters, { adapters: exploreAdapters }, { adapters: generalAdapters }] = await Promise.all([
		opts.domainAdapters ? Promise.resolve([...opts.domainAdapters]) : materializeDefaultAdapters(cwd),
		materializeBlueprint({ ...DEFAULT_COMPILED_DEFINITION, adapters: [...exploreAdapterDefs] }, materialiOpts),
		materializeBlueprint(DEFAULT_COMPILED_DEFINITION, materialiOpts),
	]);

	const contextAssembly = createContextAssembler();

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
		contextAssembly.addStage("memory", injected.createSessionContextStage({ sessionStore: () => store, contextWindow }));
	}

	const exploreStrategy = new InProcessStrategy(exploreAdapters, factory, explorePrompt);
	const generalStrategy = new InProcessStrategy(generalAdapters, factory, generalPrompt);
	injected.strategyRegistry?.register("explore", exploreStrategy);
	injected.strategyRegistry?.register("general", generalStrategy);

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
	contextAssembly.addStage(
		"compactor",
		injected.createCompactionStage({
			contextWindow,
			summarize: opts.summarize,
			publishSignal: (type: string, payload: Record<string, unknown>) => signalPublish?.(type, payload),
			getLastTokenCount: () => lastTotalTokens,
		}),
	);
	const origMount = contextAssembly.mount.bind(contextAssembly);
	(contextAssembly as { mount: typeof contextAssembly.mount }).mount = (bus) => {
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

	const adapters: Adapter[] = [...allAdapters, toolShell, contextAssembly];

	return { adapters, contextAssembly, exploreAdapters, generalAdapters };
}
