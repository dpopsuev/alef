import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { blueprintRegistry, loadAdapterFromPath } from "@dpopsuev/alef-agent-blueprint";
import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import { traceEvent } from "@dpopsuev/alef-kernel/log";
import { createContextAssemblyPipeline } from "@dpopsuev/alef-kernel/pipeline";
import type { Api, Model, ThinkingLevel } from "@dpopsuev/alef-llm";
import { createMetaAdapter } from "@dpopsuev/alef-meta";
import { AgentController, buildBootCatalog } from "@dpopsuev/alef-runtime";
import type { StorageFactory } from "@dpopsuev/alef-storage";
import type { Logger } from "pino";
import { buildAgent } from "../agent-kernel.js";
import type { Args } from "../args.js";
import { connectObservers, type SignalMapper } from "../assemble.js";
import { setupHttpSurface } from "../build-delegation.js";
import { buildLlmAdapter } from "../build-llm-adapter.js";
import type { AlefConfig } from "../config.js";
import { configureSessionActors } from "../identity/actor.js";
import { ActorRouteTable } from "../identity/routes.js";
import { buildModel } from "../model/index.js";
import { createDefaultDirectives, loadWorkspace, registerAdapters } from "../prompt.js";
import type { AgentEvent, Session, SessionState } from "../session.js";
import { SessionHandle } from "../session-lifecycle/index.js";
import type { SessionStore } from "../session-store.js";
import { makeSink } from "../sink.js";
import { buildSubagentFactory } from "../subagent-factory.js";
import type { AdapterLoadResult } from "./load-adapters.js";
import { getTheme, setTheme } from "./runner-theme.js";

const adapterSignalMaps = new Map<string, SignalMapper>();

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

export function getUiSignalHandlers(): ReadonlyMap<string, UiSignalHandler> {
	return uiSignalHandlers;
}

const uiSignalHandlerKeys = new Set<string>();

let _compacted = false;
export function isCompacted(): boolean {
	return _compacted;
}
export function markCompacted(): void {
	_compacted = true;
}

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
		ui.setStatus(
			`compacted ${Number(payload.compactedTurns ?? 0)} turns, recovered ~${Math.round(saved / 1000)}k tokens`,
		);
	});
}

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

function buildActorIdentity(store: SessionStore) {
	const boardId = store.id.slice(0, 12);
	const { humanActor, agentActor, theme } = configureSessionActors(store.id, boardId);
	setTheme({ ...getTheme(), ...theme });

	const actorRoutes = new ActorRouteTable();
	actorRoutes.setHumanAddress(humanActor.color);

	return { humanActor, agentActor, actorRoutes };
}

export async function createLocalSession(
	args: Args,
	cfg: AlefConfig,
	log: Logger,
	store: SessionStore,
	loaded: AdapterLoadResult,
	model: Model<Api>,
	storage: StorageFactory,
): Promise<{
	session: SessionHandle;
	resolvedModelDisplay: string;
	humanAddress: string;
	agentAddress: string;
	actorRoutes: ActorRouteTable;
	setupSurface: () => Promise<void>;
}> {
	const { adapters, blueprintSurfaces } = loaded;
	registerContributions(adapters);

	const directives = await buildDirectiveSet(args, adapters);

	const CONTEXT_FRACTION = 0.1;
	const CHARS_PER_TOKEN = 4;
	const directivesBudgetChars = Math.floor(model.contextWindow * CONTEXT_FRACTION * CHARS_PER_TOKEN);
	const thinkingState = {
		level: (args.thinking ?? cfg.thinking ?? (model.reasoning ? "medium" : undefined)) as ThinkingLevel | undefined,
	};
	const replySink = !args.print && !args.json && !args.noTui && process.stdin.isTTY ? undefined : makeSink(args.json);

	const sessionState: SessionState = { id: store.id, modelId: model.id, contextWindow: model.contextWindow };
	const { humanActor, agentActor, actorRoutes } = buildActorIdentity(store);

	const observers = new Set<(event: AgentEvent) => void>();
	let llmController: AbortController | undefined;
	const currentModel = model;

	const resolvedBlueprintName = loaded.blueprintName ?? "(default)";
	const stackFactory = blueprintRegistry.resolve(loaded.blueprintName);
	log.info({ blueprint: resolvedBlueprintName, available: blueprintRegistry.list() }, "blueprint:resolve");

	const subagentFactory = buildSubagentFactory({ model, trackConcurrentOps: true, forwardToolChunks: true });

	let stack: { adapters: Adapter[]; pipeline?: ReturnType<typeof createContextAssemblyPipeline> };
	if (stackFactory) {
		stack = await stackFactory({
			cwd: args.cwd,
			model,
			getSignal: () => llmController?.signal,
			sessionStore: store,
			domainAdapters: adapters,
			subagentFactory,
			writableRoots: loaded.writableRoots,
		});
	} else {
		const pipeline = createContextAssemblyPipeline();
		stack = { adapters, pipeline };
	}
	const { pipeline } = stack;

	const systemPrompt = directives.build(directivesBudgetChars);
	const enabledBlocks = directives.list({ enabled: true });
	traceEvent("directives:built", {
		ids: enabledBlocks.map((b) => b.id),
		blocks: enabledBlocks.length,
		chars: systemPrompt.length,
		tags: [...new Set(enabledBlocks.flatMap((b) => b.tags ?? []))],
	});

	const llmAdapter = buildLlmAdapter({
		model,
		cfg,
		args,
		thinkingState,
		getModel: () => currentModel,
		getSignal: () => llmController?.signal,
		schemaResolver: (name) => pipeline?.getSchemaResolver()?.(name),
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

	const sessionForum = storage.discourseStore(store.id);
	const controller = new AgentController(agent, {
		onReply: replySink,
		transcript: { store: sessionForum, topic: "sessions", thread: store.id },
	});

	actorRoutes.register(agentActor.color, async (message, timeout) => {
		await controller.send(message, "human", timeout);
	});

	for (const adapter of stack.adapters) agent.load(adapter);

	const sessionAdapter: Session = {
		state: sessionState,
		getModel: () => model.id,
		setModel: () => {},
		getThinking: () => "",
		setThinking: () => {},
		setTurnController: (c: AbortController | undefined) => {
			llmController = c;
		},
		dispose: () => {},
		receive: (text: string) => controller.receive(text, "user"),
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
			const trigger = (globalThis as Record<string, unknown>).alefRequestRebuild;
			if (typeof trigger === "function") (trigger as () => void)();
		},
	});
	agent.load(alefAdapter);

	connectObservers(agent, observers, adapterSignalMaps, uiSignalHandlerKeys);

	agent.observe({
		onCommand() {},
		onEvent() {},
		onNotification(event) {
			const p = (event as { payload?: Record<string, unknown> }).payload ?? {};
			const s = (key: string): string => (typeof p[key] === "string" ? p[key] : "");
			if (event.type === "task.completed") {
				const label = s("profile") ? `[${s("profile")}] ` : "";
				controller.receive(`${label}Background task ${s("taskId")} completed:\n${s("reply")}`, "system");
			}
			if (event.type === "task.failed") {
				controller.receive(`Background task ${s("taskId")} failed: ${s("error") || "unknown error"}`, "system");
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
	});
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
	};
}
