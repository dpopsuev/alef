const DEFAULT_LOOP_THRESHOLD = 10;
const DIRECTIVE_BUDGET_FRACTION = 0.1;
const CHARS_PER_TOKEN = 4;
const DEFAULT_CONTEXT_WINDOW = 128_000;
const EVENT_HUB_CAPACITY = 256;
const EVENT_HUB_CONCURRENCY = 8;

import type { Api, Model, ThinkingLevel } from "@dpopsuev/alef-ai/types";
import { LoopGuard } from "@dpopsuev/alef-agent/loop-detector";
import { Agent } from "@dpopsuev/alef-engine/agent";
import { buildAdapterDirectives, createToolShellAdapter, DEFAULT_ALWAYS_FULL_NAMESPACES, DEFAULT_ALWAYS_FULL_TOOLS } from "@dpopsuev/alef-engine/catalog";
import { AgentController } from "@dpopsuev/alef-engine/controller";
import { createAdapterCommandRouter, type Adapter, type ToolDefinition } from "@dpopsuev/alef-kernel/adapter";
import type { CommandRouter } from "@dpopsuev/alef-kernel/capabilities";
import { EventHub, type EventEnvelope } from "@dpopsuev/alef-kernel/events";
import type { AgentBus } from "@dpopsuev/alef-kernel/bus";
import { newCorrelationId } from "@dpopsuev/alef-kernel/bus";
import { createContextPipeline, type ContextPipeline } from "@dpopsuev/alef-kernel/context-assembly";
import type { DesiredStateSpec } from "@dpopsuev/alef-kernel/reconciliation";
import type { AgentEvent } from "@dpopsuev/alef-session/contracts";
import type { SessionStore } from "@dpopsuev/alef-session/storage";
import { ToolChunked, ToolCompleted, ToolProgressed, ToolStarted } from "@dpopsuev/alef-reasoner/events";
import { connectObservers, type SignalMapper } from "./assemble.js";
export type { SignalMapper } from "./assemble.js";
import { buildLlm, type LlmBuildOptions } from "./build-llm.js";
import { Directives, xmlRenderer } from "./directives.js";
import { SessionLog, type SessionSummary } from "./event-log-adapter.js";
import type { ActorIdentity } from "./identity/actor.js";
import { createDefaultDirectives, registerAdapters } from "./prompt.js";
import { type GapSnapshot, ProgressTelemetry } from "./progress-telemetry.js";

/** Delays model-adapter construction until session capabilities are materialized. */
export type AgentLlmFactory = (runtime: {
	contextPipeline: ContextPipeline;
	commandRouter: CommandRouter;
	eventHub: EventHub;
	systemPrompt: string;
}) => Adapter;

/** Keeps every runtime host on the same assembly path. */
export interface CreateAgentSessionOptions {
	cwd: string;
	model?: Model<Api>;
	adapters: readonly Adapter[];
	thinking?: ThinkingLevel;
	getSignal?: () => AbortSignal | undefined;
	getApiKey?: (provider: string) => string | undefined;
	schemaResolver?: (name: string) => ToolDefinition | undefined;
	directives?: Directives;
	systemPrompt?: string;
	llmAdapter?: Adapter;
	llmFactory?: AgentLlmFactory;
	llm?: LlmBuildOptions["llm"];
	trackConcurrentOps?: boolean;
	desiredState?: DesiredStateSpec;
	contextPipeline?: ContextPipeline;
	commandRouter?: CommandRouter;
	commandPermissions?: readonly string[];
	eventHub?: EventHub;
	composeToolShell?: boolean;
	toolDisclosure?: "full" | "progressive";
	session?: SessionStore;
	modelId?: string;
	loopThreshold?: number;
	onLoop?: (eventType: string, reason: string) => void;
	agentIdentity?: ActorIdentity;
	summaryWriter?: (summary: SessionSummary) => void | Promise<void>;
	bus?: AgentBus;
	getGap?: () => GapSnapshot | null;
	onReply?: (text: string) => void;
	signalMappers?: ReadonlyMap<string, SignalMapper>;
	uiSignalTypes?: ReadonlySet<string>;
	createAdapters?: (runtime: {
		agent: Agent;
		controller: AgentController;
		observers: Set<(event: AgentEvent) => void>;
	}) => readonly Adapter[];
}

/** Couples control and disposal so hosts cannot partially own runtime lifecycle. */
export interface AgentSessionRuntime {
	readonly agent: Agent;
	readonly controller: AgentController;
	readonly observers: Set<(event: AgentEvent) => void>;
	readonly eventHub: EventHub;
	readonly systemPrompt: string;
	dispose(): Promise<void>;
}

/** Excludes persona blocks when a host supplies its own system prompt. */
function createLeanDirectives(opts: {
	systemPrompt: string;
	adapters: readonly Adapter[];
	cwd: string;
}): Directives {
	const directives = new Directives();
	directives.renderer = xmlRenderer;
	directives.register({
		id: "session.system",
		priority: 0,
		content: opts.systemPrompt,
		enabled: true,
		tags: ["session"],
	});
	const environment = createDefaultDirectives({
		tools: opts.adapters.flatMap((adapter) => adapter.tools),
		cwd: opts.cwd,
	}).get("environment");
	if (environment) directives.register(environment);
	registerAdapters(directives, opts.adapters);
	return directives;
}

/** Preserves progress telemetry for reasoners that expose reconciliation state. */
function gapFromLlm(llm: Adapter): () => GapSnapshot | null {
	const surface = llm as Adapter & {
		getErrorTensor?: () => { totalMagnitude: number; converged: boolean } | null;
		recompute?: () => unknown;
	};
	if (typeof surface.getErrorTensor !== "function") return () => null;
	return () => {
		surface.recompute?.();
		const tensor = surface.getErrorTensor?.();
		return tensor ? { totalMagnitude: tensor.totalMagnitude, converged: tensor.converged } : null;
	};
}

/** Centralizes readiness, control, observers, and disposal across every host. */
export async function createAgentSession(opts: CreateAgentSessionOptions): Promise<AgentSessionRuntime> {
	const agentSlot: { current?: Agent } = {};
	const tools = opts.adapters.flatMap((adapter) => adapter.tools);
	const toolShell = opts.composeToolShell === false
		? undefined
		: createToolShellAdapter({
				tools,
				getTools: () =>
					agentSlot.current
						? agentSlot.current.tools.filter((tool) => !["tools.describe", "tools.status", "tools.cancel"].includes(tool.name))
						: tools,
				adapterDirectives: buildAdapterDirectives(opts.adapters),
				disclosure: opts.toolDisclosure ?? "progressive",
				alwaysFullNamespaces: [...DEFAULT_ALWAYS_FULL_NAMESPACES],
				alwaysFullTools: [...DEFAULT_ALWAYS_FULL_TOOLS],
			});
	const runtimeAdapters = toolShell ? [...opts.adapters, toolShell] : opts.adapters;
	const contextPipeline = opts.contextPipeline ?? createContextPipeline();
	contextPipeline.addAdapters(runtimeAdapters);
	const commandRouter = opts.commandRouter ?? createAdapterCommandRouter(runtimeAdapters);
	const eventHub = opts.eventHub ?? new EventHub({ capacity: EVENT_HUB_CAPACITY, concurrency: EVENT_HUB_CONCURRENCY });
	const ownsEventHub = opts.eventHub === undefined;
	const directives = opts.systemPrompt !== undefined
		? createLeanDirectives({ systemPrompt: opts.systemPrompt, adapters: opts.adapters, cwd: opts.cwd })
		: opts.directives ?? (() => {
			const defaults = createDefaultDirectives({ tools, cwd: opts.cwd });
			registerAdapters(defaults, opts.adapters);
			return defaults;
		})();
	const budgetChars = Math.floor(
		(opts.model?.contextWindow ?? DEFAULT_CONTEXT_WINDOW) * DIRECTIVE_BUDGET_FRACTION * CHARS_PER_TOKEN,
	);
	const systemPrompt = directives.build(budgetChars);
	const thinkingState = { level: opts.thinking ?? (opts.model?.reasoning ? "medium" : undefined) };
	if (opts.llmAdapter && opts.llmFactory) throw new Error("createAgentSession accepts llmAdapter or llmFactory, not both");
	let llm = opts.llmAdapter ?? opts.llmFactory?.({ contextPipeline, commandRouter, eventHub, systemPrompt });
	if (!llm) {
		if (!opts.model) throw new Error("createAgentSession requires model or llmAdapter");
		const model = opts.model;
		llm = buildLlm({
			model,
			thinkingState,
			getModel: () => model,
			getSignal: opts.getSignal ?? (() => undefined),
			getApiKey: opts.getApiKey,
			schemaResolver: opts.schemaResolver ?? ((name) => contextPipeline.resolveSchema(name)),
			contextPipeline,
			commandRouter,
			commandPermissions: opts.commandPermissions,
			eventHub,
			systemPrompt,
			llm: opts.llm,
			trackConcurrentOps: opts.trackConcurrentOps ?? true,
		});
	}

	if (process.env.ALEF_OTEL === "1" || process.env.TRACEPARENT?.trim()) {
		const { setupOTel, upgradeToSqliteExporter } = await import("./otel-setup.js");
		setupOTel();
		await upgradeToSqliteExporter();
	}

	const agent = new Agent({ bus: opts.bus });
	agentSlot.current = agent;
	const projectToolEvent = (event: EventEnvelope<Record<string, unknown>>): void => {
		agent.asBus().event.publish({
			type: event.type,
			correlationId: event.correlationId ?? event.id,
			payload: {
				...event.payload,
				eventId: event.id,
				version: event.version,
				causationId: event.causationId,
				scope: event.scope,
			},
			isError: false,
		});
	};
	const eventHubUnsubscribers = [
		eventHub.subscribe(ToolStarted, projectToolEvent),
		eventHub.subscribe(ToolChunked, projectToolEvent),
		eventHub.subscribe(ToolProgressed, projectToolEvent),
		eventHub.subscribe(ToolCompleted, projectToolEvent),
	];
	agent.load(llm);
	agent.load(new LoopGuard({ repeatedInteractionThreshold: opts.loopThreshold ?? DEFAULT_LOOP_THRESHOLD, onLoop: opts.onLoop }));
	agent.load(new ProgressTelemetry({ getGap: opts.getGap ?? gapFromLlm(llm) }));
	if (opts.session) {
		agent.load(new SessionLog(opts.session, opts.modelId, opts.agentIdentity, opts.summaryWriter));
	}
	for (const adapter of opts.adapters) agent.load(adapter);
	if (toolShell) agent.load(toolShell);

	const observers = new Set<(event: AgentEvent) => void>();
	const controller = new AgentController(agent, { onReply: opts.onReply });
	connectObservers(agent, observers, opts.signalMappers, opts.uiSignalTypes);
	for (const adapter of opts.createAdapters?.({ agent, controller, observers }) ?? []) agent.load(adapter);
	agent.validate();
	await agent.ready();

	if (opts.desiredState) {
		agent.asBus().notification.publish({
			type: "plan.dss",
			payload: { intent: opts.desiredState.intent, dimensions: opts.desiredState.dimensions },
			correlationId: newCorrelationId(),
		});
	}

	return {
		agent,
		controller,
		observers,
		eventHub,
		systemPrompt,
		async dispose() {
			controller.dispose();
			for (const unsubscribe of eventHubUnsubscribers) unsubscribe();
			await agent.dispose();
			if (ownsEventHub) eventHub.close();
		},
	};
}
