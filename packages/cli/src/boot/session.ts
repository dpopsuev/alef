import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { connectObservers, type SignalMapper } from "@dpopsuev/alef-agent/assemble";
import { type ActorIdentity, configureSessionActors } from "@dpopsuev/alef-agent/identity/actor";
import { ActorRouteTable } from "@dpopsuev/alef-agent/identity/routes";
import { buildAgent } from "@dpopsuev/alef-agent/kernel";
import { buildModel } from "@dpopsuev/alef-agent/model";
import { createDefaultDirectives, registerAdapters } from "@dpopsuev/alef-agent/prompt";
import { createResourceMeter } from "@dpopsuev/alef-agent/resource-meter";
import { buildSubagentFactory } from "@dpopsuev/alef-agent/subagent-factory";
import type { Api, Model, ThinkingLevel } from "@dpopsuev/alef-ai/types";
import { loadAdapterFromPath } from "@dpopsuev/alef-blueprint/materializer";
import { blueprintRegistry } from "@dpopsuev/alef-blueprint/registry";
import { buildBootCatalog } from "@dpopsuev/alef-engine/catalog";
import { AgentController } from "@dpopsuev/alef-engine/controller";
import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import { traceEvent } from "@dpopsuev/alef-kernel/log";
import type { AgentEvent, Session, SessionState } from "@dpopsuev/alef-session/contracts";
import type { SessionStore } from "@dpopsuev/alef-session/storage";
import { createTokenTelemetry } from "@dpopsuev/alef-session/token-telemetry";
import type { StorageFactory } from "@dpopsuev/alef-storage";
import {
	type DiscourseBackend,
	InMemoryDiscourseStore,
	maybeMirrorToScribe,
	openDiscourseBackend,
	scribeCallFromEnv,
} from "@dpopsuev/alef-tool-discourse";
import { createMetaAdapter } from "@dpopsuev/alef-tool-meta";
import type { Logger } from "pino";
import { getTheme, setTheme } from "../client/theme.js";
import type { AdapterLoadResult } from "./adapters.js";
import type { Args } from "./args.js";
import { type HttpSurface, setupHttpSurface } from "./build-delegation.js";
import { buildLlmAdapter } from "./build-llm-adapter.js";
import type { AlefConfig } from "./config.js";
import { deriveDiscussionState } from "./discussion.js";
import { SessionHandle } from "./handle.js";
import { makeSink } from "./output.js";
import { loadWorkspace } from "./workspace.js";

const DIRECTIVE_BUDGET_FRACTION = 0.1;
const CHARS_PER_TOKEN_ESTIMATE = 4;

/** Narrow unknown payload fragments to plain records. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

const adapterSignalMaps = new Map<string, SignalMapper>();

/** Collect signal-type-to-mapper entries from adapter contributions into the global map. */
function registerAdapterSignalMaps(
	adapters: readonly { contributions?: { "signal.map"?: Readonly<Record<string, SignalMapper>> } }[],
): void {
	for (const adapter of adapters) {
		const map = adapter.contributions?.["signal.map"];
		if (!map) continue;
		for (const [signalType, mapper] of Object.entries(map)) {
			adapterSignalMaps.set(signalType, mapper);
		}
	}
}

import type { UiContribution, UiSignalHandler } from "@dpopsuev/alef-kernel/adapter";

const uiSignalHandlers = new Map<string, UiSignalHandler>();

/** Collect UI signal handlers from adapter contributions into the global handler map. */
function registerUiSignals(adapters: readonly { contributions?: { ui?: UiContribution } }[]): void {
	for (const adapter of adapters) {
		const signals = adapter.contributions?.ui?.signals;
		if (!signals) continue;
		for (const [signalType, handler] of Object.entries(signals)) {
			uiSignalHandlers.set(signalType, handler);
			uiSignalHandlerKeys.add(signalType);
		}
	}
}

/** Return the map of registered UI signal handlers contributed by adapters. */
export function getUiSignalHandlers(): ReadonlyMap<string, UiSignalHandler> {
	return uiSignalHandlers;
}

const uiSignalHandlerKeys = new Set<string>();

let _compacted = false;
/** Return whether the context window has been compacted during this session. */
export function isCompacted(): boolean {
	return _compacted;
}
/** Flag that context compaction has occurred during this session. */
export function markCompacted(): void {
	_compacted = true;
}

/** Register all adapter contributions (signal maps, UI handlers) and add the compaction handler. */
function registerContributions(
	adapters: readonly {
		contributions?: { "signal.map"?: Readonly<Record<string, SignalMapper>>; ui?: UiContribution };
	}[],
): void {
	registerAdapterSignalMaps(adapters);
	registerUiSignals(adapters);
	uiSignalHandlerKeys.add("context.compacted");
	uiSignalHandlers.set("context.compacted", (payload, ui) => {
		markCompacted();
		const before = Number(payload.estimatedBefore ?? 0);
		const after = Number(payload.estimatedAfter ?? 0);
		const saved = before - after;
		ui.setNotice(
			`compacted ${Number(payload.compactedTurns ?? 0)} turns, recovered ~${Math.round(saved / 1000)}k tokens`,
			2,
		);
	});
	uiSignalHandlerKeys.add("context.compacting");
	uiSignalHandlers.set("context.compacting", (payload, ui) => {
		// Only show while active. Do not clear on false — context.compacted owns the
		// completion notice (clearing here would wipe "compacted N turns…" immediately).
		if (payload.active) ui.setNotice("Compacting context...");
	});
	uiSignalHandlerKeys.add("context.overflow-recovery");
	uiSignalHandlers.set("context.overflow-recovery", (payload, ui) => {
		if (payload.willRetry) {
			ui.setNotice("Context overflow detected, auto-compacting...");
			return;
		}
		ui.setNotice(
			typeof payload.errorMessage === "string" && payload.errorMessage
				? payload.errorMessage
				: "Context overflow recovery failed",
		);
	});
	uiSignalHandlerKeys.add("session.metadata.refresh");
	uiSignalHandlers.set("session.metadata.refresh", (payload, ui) => {
		if (typeof payload.title === "string" && payload.title.trim()) {
			ui.setTopicLabel(payload.title.trim());
		}
	});
}

/** Assemble the system-prompt directive set from workspace files and adapter registrations. */
async function buildDirectiveSet(args: Args, adapters: readonly Adapter[]) {
	const directives = createDefaultDirectives({ tools: adapters.flatMap((o) => o.tools), cwd: args.cwd });
	await loadWorkspace(directives, args.cwd);
	registerAdapters(directives, adapters);

	if (args.debug) {
		const skillPath = join(dirname(new URL(import.meta.url).pathname), "skills/debug-alef/SKILL.md");
		try {
			const skillContent = readFileSync(skillPath, "utf-8");
			directives.register({
				id: "debug-alef-skill",
				priority: 800,
				content: () => skillContent,
				enabled: true,
				tags: ["debug"],
			});
		} catch {
			// Skill file absent — skip silently.
		}
	}

	return directives;
}

/** Actor identities and route table for the current session. */
export interface IdentityContext {
	humanActor: ActorIdentity;
	agentActor: ActorIdentity;
	actorRoutes: ActorRouteTable;
}

/** Derive human and agent actor identities from the session store and apply theme colors. */
export function buildIdentityContext(store: SessionStore): IdentityContext {
	const boardId = store.id.slice(0, 12);
	const { humanActor, agentActor } = configureSessionActors(store.id, boardId);
	setTheme({ ...getTheme(), userFg: { truecolor: humanActor.hex }, agentFg: { truecolor: agentActor.hex } });

	const actorRoutes = new ActorRouteTable();
	actorRoutes.setHumanAddress(humanActor.address);

	return { humanActor, agentActor, actorRoutes };
}

/** Assemble a fully wired local session with LLM adapter, directives, and agent. */
export async function createLocalSession(
	args: Args,
	cfg: AlefConfig,
	log: Logger,
	store: SessionStore,
	loaded: AdapterLoadResult,
	model: Model<Api>,
	storage: StorageFactory,
	identity: IdentityContext,
	discourseBackendOverride?: DiscourseBackend,
): Promise<{
	session: SessionHandle;
	resolvedModelDisplay: string;
	humanAddress: string;
	agentAddress: string;
	actorRoutes: ActorRouteTable;
	setupSurface: () => Promise<HttpSurface | undefined>;
	blueprintName: string;
}> {
	const { adapters, blueprintSurfaces } = loaded;
	registerContributions(adapters);

	const directives = await buildDirectiveSet(args, adapters);

	const directivesBudgetChars = Math.floor(model.contextWindow * DIRECTIVE_BUDGET_FRACTION * CHARS_PER_TOKEN_ESTIMATE);
	const thinkingState = {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- args/cfg provide validated ThinkingLevel strings
		level: (args.thinking ?? cfg.thinking ?? (model.reasoning ? "medium" : undefined)) as ThinkingLevel | undefined,
	};
	const replySink = !args.print && !args.json && !args.noTui && process.stdin.isTTY ? undefined : makeSink(args.json);

	const discussion = deriveDiscussionState(store, args.cwd);
	process.env.ALEF_DISCUSSION_FORUM = discussion.active.forumId;
	process.env.ALEF_DISCUSSION_TOPIC = discussion.active.topicId;
	process.env.ALEF_DISCUSSION_HOME_TOPIC = discussion.home.topicId;
	const discourseBackend: DiscourseBackend =
		discourseBackendOverride ??
		(storage.database
			? await openDiscourseBackend({
					client: storage.database(),
					sessionId: store.id,
					scribeCall: scribeCallFromEnv(),
					logger: log,
				})
			: maybeMirrorToScribe(new InMemoryDiscourseStore(), {
					scribeCall: scribeCallFromEnv(),
					logger: log,
				}));
	const sessionState: SessionState = {
		id: store.id,
		modelId: model.id,
		contextWindow: model.contextWindow,
		discussion,
	};
	const { humanActor, agentActor, actorRoutes } = identity;
	const boardId = store.id.slice(0, 12);

	const observers = new Set<(event: AgentEvent) => void>();
	let llmController: AbortController | undefined;
	/** Mutable — SessionHandle.setModel updates this so the LLM adapter sees switches. */
	let currentModel = model;

	// Resolve the blueprint name from the registry, falling back to loaded.blueprintName
	// When no explicit blueprint is provided, we use the default blueprint's registered name
	const resolvedBlueprintName = loaded.blueprintName ?? blueprintRegistry.getDefaultName() ?? "(default)";
	const stackFactory = blueprintRegistry.resolve(loaded.blueprintName) ?? blueprintRegistry.resolve();
	if (!stackFactory) {
		throw new Error(
			`No blueprint factory resolved for "${resolvedBlueprintName}". ` +
				`Available: ${blueprintRegistry.list().join(", ") || "(none)"}. ` +
				`Ensure @dpopsuev/alef-coding-agent is imported.`,
		);
	}
	log.info({ blueprint: resolvedBlueprintName, available: blueprintRegistry.list() }, "blueprint:resolve");

	const subagentFactory = buildSubagentFactory({
		model,
		trackConcurrentOps: true,
		forwardToolChunks: true,
		parentSessionId: store.id,
		boardId,
		actorRoutes,
	});

	const getParentDirectives = async () => Promise.resolve(directives.build(directivesBudgetChars));

	const stack = await stackFactory({
		cwd: args.cwd,
		model,
		getSignal: () => llmController?.signal,
		getParentDirectives,
		sessionStore: store,
		domainAdapters: adapters,
		subagentFactory,
		writableRoots: loaded.writableRoots,
		toolDisclosure: cfg.tool_disclosure,
	});
	const { contextAssembly } = stack;

	const systemPrompt = directives.build(directivesBudgetChars);
	const blockSizes = directives.blockSizes();
	const enabledBlocks = directives.list({ enabled: true });
	traceEvent("directives:built", {
		ids: enabledBlocks.map((b) => b.id),
		blocks: enabledBlocks.length,
		chars: systemPrompt.length,
		estTokens: Math.round(systemPrompt.length / 4),
		blockSizes,
		tags: [...new Set(enabledBlocks.flatMap((b) => b.tags ?? []))],
	});

	const llmAdapter = buildLlmAdapter({
		model,
		cfg,
		args,
		thinkingState,
		getModel: () => currentModel,
		getSignal: () => llmController?.signal,
		schemaResolver: (name) => contextAssembly.getSchemaResolver()?.(name),
		systemPrompt,
	});

	const summaryStore = storage.summaryStore();

	const agent = buildAgent({
		llm: llmAdapter,
		session: store,
		modelId: model.id,
		agentIdentity: agentActor,
		onLoop: (_type, reason) => {
			traceEvent("loop:detected", { reason });
			llmController?.abort(new Error(`[loop-detector] ${reason}`));
		},
		summaryWriter: (summary) => summaryStore.write(summary),
	});

	const controller = new AgentController(agent, { onReply: replySink });

	actorRoutes.register(agentActor.address, async (message, timeout) => {
		await controller.send(message, "human", timeout);
	});

	for (const adapter of stack.adapters) agent.load(adapter);
	agent.load(createTokenTelemetry(store.id));
	agent.load(createResourceMeter());

	const handleSlot: { current?: SessionHandle } = {};
	const sessionAdapter: Session = {
		state: sessionState,
		getModel: () => handleSlot.current?.getModel() ?? currentModel.id,
		setModel: (id: string) => {
			handleSlot.current?.setModel(id);
		},
		getThinking: () => handleSlot.current?.getThinking() ?? "",
		setThinking: (level: string) => {
			handleSlot.current?.setThinking(level);
		},
		setTurnController: (c: AbortController | undefined) => {
			llmController = c;
			handleSlot.current?.setTurnController(c);
		},
		dispose: () => {
			void handleSlot.current?.dispose();
		},
		receive: (content, opts?) => {
			const text =
				typeof content === "string"
					? content
					: content
							.filter((part): part is { type: "text"; text: string } => part.type === "text")
							.map((part) => part.text)
							.join("");
			if (handleSlot.current) {
				handleSlot.current.receive(text, opts);
				return;
			}
			controller.receive(text, "user", undefined, opts?.delivery);
		},
		subscribe: (obs: (event: AgentEvent) => void) => {
			observers.add(obs);
			return () => observers.delete(obs);
		},
	};
	const setupSurface = () => setupHttpSurface(args, agent, sessionAdapter, blueprintSurfaces);

	const alefAdapter = createMetaAdapter({
		agent: {
			load: (o: Adapter) => agent.load(o),
			unload: (n: string) => agent.unload(n),
			get adapters() {
				return agent.adapters;
			},
		},
		loadAdapter: (path: string, cwd: string) => loadAdapterFromPath(path, { cwd }),
		cwd: args.cwd,
		dialogEventType: "llm.input",
		onRebuildRequest: () => {
			const g = globalThis as Record<string, unknown>;
			if (typeof g.alefReboot === "function") (g.alefReboot as () => void)(); // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- validated by typeof
		},
	});
	// Meta tools stay on the bus for :meta / prototype paths — hide from LLM tool schemas.
	agent.load({ ...alefAdapter, tools: [] });

	connectObservers(agent, observers, adapterSignalMaps, uiSignalHandlerKeys);

	agent.observe({
		onCommand() {},
		onEvent() {},
		onNotification(event) {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- BusMessage concrete subtypes carry payload
			const p = (event as { payload?: Record<string, unknown> }).payload ?? {};
			const task = isRecord(p.task) ? p.task : undefined;
			const descriptor = task && isRecord(task.descriptor) ? task.descriptor : undefined;
			const taskId = typeof descriptor?.taskId === "string" ? descriptor.taskId : "";
			const profile = typeof descriptor?.profile === "string" ? descriptor.profile : "";
			const s = (key: string): string => (typeof p[key] === "string" ? p[key] : "");
			if (event.type === "task.completed") {
				const label = profile ? `[${profile}] ` : "";
				controller.receive(`${label}Background task ${taskId} completed:\n${s("reply")}`, "system");
			}
			if (event.type === "task.failed") {
				controller.receive(`Background task ${taskId} failed: ${s("error") || "unknown error"}`, "system");
			}
			if (event.type === "task.cancelled") {
				controller.receive(`Background task ${taskId} cancelled`, "system");
			}
		},
	});

	directives.register({
		id: "tool-shell.boot-catalog",
		priority: 900,
		content: () => buildBootCatalog(agent.tools),
		enabled: true,
		tags: ["adapter", "dynamic"],
	});

	agent.validate();
	await agent.ready();

	const handle = new SessionHandle({
		state: sessionState,
		model,
		thinkingState,
		controller,
		agent,
		directives,
		args,
		log,
		observers,
		modelFactory: buildModel,
		discussion,
		discourseBackend,
		humanAddress: humanActor.address,
		agentAddress: agentActor.address,
		onModelChange: (next) => {
			currentModel = next;
		},
	});
	handleSlot.current = handle;
	if (llmController) handle.setTurnController(llmController);

	const resolvedModelDisplay =
		model.name !== model.id ? `${model.provider}/${model.id} (${model.name})` : `${model.provider}/${model.id}`;

	return {
		session: handle,
		resolvedModelDisplay,
		humanAddress: humanActor.address,
		agentAddress: agentActor.address,
		actorRoutes,
		setupSurface,
		blueprintName: resolvedBlueprintName,
	};
}

export type { SessionPreviewProvider } from "@dpopsuev/alef-storage";
export { SessionHandle } from "./handle.js";
export { type LoadSessionArgs, loadSession, type SessionPicker } from "./load.js";
