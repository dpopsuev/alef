/**
 * Delegation stack builder — wires explore/general strategies and context assembly
 * from prebuilt adapters injected by the composition root (profiles).
 */

import type { SubagentFactory } from "./subagent-port.js";
import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import type { ContextAssemblyHandler } from "@dpopsuev/alef-kernel/contributions";
import { createContextAssembler } from "@dpopsuev/alef-kernel/context-assembly";
import type { WorkContext } from "@dpopsuev/alef-kernel/execution";
import {
	buildAdapterDirectives,
	createToolShellAdapter,
	DEFAULT_ALWAYS_FULL_NAMESPACES,
	DEFAULT_ALWAYS_FULL_TOOLS,
} from "./tool-catalog.js";
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
	getParentDirectives?: () => Promise<string>;
	domainAdapters: readonly Adapter[];
	exploreAdapters: readonly Adapter[];
	generalAdapters: readonly Adapter[];
	sessionStore?: unknown;
	writableRoots?: readonly string[];
	explorePrompt?: string;
	generalPrompt?: string;
	extraAdapters?: Adapter[];
	excludeNames?: string[];
	summarize?: (messages: readonly unknown[]) => Promise<string>;
	/** Auto-compaction strategy for createCompactionStage. Default summarize. */
	compactionStrategy?: "summarize" | "shake" | "off";
	adapters: DelegationAdapters;
	allowedBlueprints?: readonly string[];
	profileRoles?: Record<string, NonNullable<WorkContext["role"]>>;
	profilePrompts?: Record<string, string>;
	materializeAdapters: (names: string[]) => Promise<Adapter[]>;
	/** Policy-A plan retitle: called when plan.opened fires with desired text. */
	onPlanOpened?: (desired: string) => void | Promise<void>;
	/** Override ToolShell disclosure (default progressive for coding stack). */
	toolDisclosure?: "full" | "progressive";
}

/** Materialized adapter set with explore/general strategies and context assembly pipeline. */
export interface DelegationStack {
	adapters: Adapter[];
	contextAssembly: ReturnType<typeof createContextAssembler>;
	exploreAdapters: Adapter[];
	generalAdapters: Adapter[];
}

/** Wire explore/general strategies and assemble the context pipeline from prebuilt adapters. */
export async function buildDelegationStack(opts: DelegationStackOptions): Promise<DelegationStack> {
	const {
		cwd,
		factory,
		contextWindow,
		exploreAdapters,
		generalAdapters,
		domainAdapters,
		explorePrompt = EXPLORE_SYSTEM_PROMPT,
		generalPrompt = GENERAL_SYSTEM_PROMPT,
		extraAdapters = [],
		excludeNames = [],
		adapters: injected,
		materializeAdapters,
		allowedBlueprints = [],
	} = opts;

	const resolvedDomainAdapters = [...domainAdapters];
	const resolvedExploreAdapters = [...exploreAdapters];
	const resolvedGeneralAdapters = [...generalAdapters];

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

	const exploreStrategy = new InProcessStrategy(resolvedExploreAdapters, factory, explorePrompt);
	const generalStrategy = new InProcessStrategy(resolvedGeneralAdapters, factory, generalPrompt);
	injected.strategyRegistry?.register("explore", exploreStrategy);
	injected.strategyRegistry?.register("general", generalStrategy);

	const parentAdapterNames = new Set(resolvedDomainAdapters.map((a: Adapter) => a.name));
	const agentAdapter = injected.createAgentAdapter({
		cwd,
		getParentDirectives: opts.getParentDirectives,
		strategies: { explore: exploreStrategy, general: generalStrategy },
		replyEvent: "llm.response",
		writableRoots: opts.writableRoots,
		parentAdapterNames,
		allowedBlueprints,
		materializeAdapters: async (names: string[]) => {
			const allowed = names.filter((n: string) => parentAdapterNames.has(n));
			return materializeAdapters(allowed);
		},
		subagentFactory: factory,
		profileRoles: opts.profileRoles,
		profilePrompts: opts.profilePrompts,
	});

	let signalPublish: ((type: string, payload: Record<string, unknown>) => void) | undefined;
	let lastTotalTokens = 0;
	let pendingForceCompact: { instructions?: string; strategy?: "summarize" | "shake" } | undefined;
	contextAssembly.addStage(
		"compactor",
		injected.createCompactionStage({
			contextWindow,
			strategy: opts.compactionStrategy ?? "summarize",
			summarize: opts.summarize,
			sessionStore: opts.sessionStore ? () => opts.sessionStore : undefined,
			publishSignal: (type: string, payload: Record<string, unknown>) => signalPublish?.(type, payload),
			getLastTokenCount: () => lastTotalTokens,
			pullForceCompact: () => {
				const force = pendingForceCompact;
				pendingForceCompact = undefined;
				return force;
			},
		}),
	);
	const origMount = contextAssembly.mount.bind(contextAssembly);
	(contextAssembly as { mount: typeof contextAssembly.mount }).mount = (bus) => {
		signalPublish = (type, payload) => bus.notification.publish({ type, payload, correlationId: "" });
		bus.notification.subscribe("llm.token-usage", (event) => {
			const usage = (event as { payload?: { usage?: { totalTokens?: number } } }).payload?.usage;
			if (usage?.totalTokens) lastTotalTokens = usage.totalTokens;
		});
		bus.notification.subscribe("context.compacted", (event) => {
			const after = (event as { payload?: { estimatedAfter?: number } }).payload?.estimatedAfter;
			if (typeof after === "number" && after >= 0) lastTotalTokens = after;
		});
		bus.notification.subscribe("context.compact.request", (event) => {
			const instructions =
				typeof event.payload.instructions === "string" ? event.payload.instructions : undefined;
			const strategyRaw = event.payload.strategy;
			const strategy =
				strategyRaw === "shake" || strategyRaw === "summarize" ? strategyRaw : undefined;
			pendingForceCompact = { instructions, strategy };
		});
		if (opts.onPlanOpened) {
			const onPlanOpened = opts.onPlanOpened;
			bus.notification.subscribe("plan.opened", (event) => {
				const desired = typeof event.payload.desired === "string" ? event.payload.desired : "";
				if (!desired) return;
				void onPlanOpened(desired);
			});
		}
		return origMount(bus);
	};

	const baseExclude = new Set(["agent", "compactor", ...excludeNames]);
	const filteredDomain = resolvedDomainAdapters.filter((o: Adapter) => !baseExclude.has(o.name));
	const allAdapters = [...filteredDomain, ...extraAdapters, agentAdapter];
	const toolShell = createToolShellAdapter({
		tools: allAdapters.flatMap((o: Adapter) => o.tools),
		getTools: () => allAdapters.flatMap((o: Adapter) => o.tools),
		adapterDirectives: buildAdapterDirectives(allAdapters),
		disclosure: opts.toolDisclosure ?? "progressive",
		alwaysFullNamespaces: [...DEFAULT_ALWAYS_FULL_NAMESPACES],
		alwaysFullTools: [...DEFAULT_ALWAYS_FULL_TOOLS],
	});

	const adapters: Adapter[] = [...allAdapters, toolShell, contextAssembly];

	return {
		adapters,
		contextAssembly,
		exploreAdapters: resolvedExploreAdapters,
		generalAdapters: resolvedGeneralAdapters,
	};
}
