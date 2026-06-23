import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { blueprintRegistry, loadOrganFromPath } from "@dpopsuev/alef-agent-blueprint";
import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import type { BusMessage } from "@dpopsuev/alef-kernel/bus";
import { traceEvent } from "@dpopsuev/alef-kernel/log";
import { createContextAssemblyPipeline } from "@dpopsuev/alef-kernel/pipeline";
import type { Api, Model, ThinkingLevel } from "@dpopsuev/alef-llm";
import { createMetaOrgan } from "@dpopsuev/alef-meta";
import { type Agent, AgentController, buildBootCatalog } from "@dpopsuev/alef-runtime";
import { SqliteDiscourseStore } from "@dpopsuev/alef-storage";
import type { Logger } from "pino";
import { buildAgent } from "./agent-kernel.js";
import type { Args } from "./args.js";
import { setupHttpSurface } from "./build-delegation.js";
import { buildLlmAdapter } from "./build-llm-adapter.js";
import type { AlefConfig } from "./config.js";
import { configureSessionActors } from "./identity/actor.js";
import { ActorRouteTable } from "./identity/routes.js";
import type { AdapterLoadResult } from "./load-adapters.js";
import { buildModel } from "./model/index.js";
import { createDefaultDirectives, loadWorkspace, registerAdapters } from "./prompt.js";
import type { AgentEvent, Session, SessionState, TokensConsumed } from "./session.js";
import { SessionHandle } from "./session-lifecycle/index.js";
import type { SessionStore } from "./session-store.js";
import { makeSink } from "./sink.js";
import { buildSubagentFactory } from "./subagent-factory.js";
import { getTheme, setTheme } from "./theme.js";

type SignalMapper = (payload: Record<string, unknown>) => Record<string, unknown> | null;
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

import type { TuiContribution, TuiSignalHandler } from "@dpopsuev/alef-kernel/adapter";

const tuiSignalHandlers = new Map<string, TuiSignalHandler>();

function registerTuiSignals(adapters: readonly { contributions?: { tui?: TuiContribution } }[]): void {
	for (const adapter of adapters) {
		const signals = adapter.contributions?.tui?.signals;
		if (!signals) continue;
		for (const [signalType, handler] of Object.entries(signals)) {
			tuiSignalHandlers.set(signalType, handler);
		}
	}
}

export function getTuiSignalHandlers(): ReadonlyMap<string, TuiSignalHandler> {
	return tuiSignalHandlers;
}

let _compacted = false;
export function isCompacted(): boolean {
	return _compacted;
}
export function markCompacted(): void {
	_compacted = true;
}

function signalToAgentEvent(event: BusMessage): AgentEvent | null {
	const p = (event as { payload?: Record<string, unknown> }).payload ?? {};
	switch (event.type) {
		case "llm.chunk":
			return { type: "chunk", text: typeof p.text === "string" ? p.text : "" };
		case "llm.thinking":
			return { type: "thinking", text: typeof p.text === "string" ? p.text : "" };
		case "llm.tool-start":
			return {
				type: "tool-start",
				callId: String(p.callId),
				name: String(p.name),
				args: (p.args ?? {}) as Record<string, unknown>,
			};
		case "llm.tool-end":
			return {
				type: "tool-end",
				callId: String(p.callId),
				elapsedMs: Number(p.elapsedMs),
				ok: Boolean(p.ok),
				display: p.display as string | undefined,
				displayKind: p.displayKind as string | undefined,
			};
		case "llm.tool-chunk":
			return { type: "tool-chunk", callId: String(p.callId), text: typeof p.text === "string" ? p.text : "" };
		case "llm.tool-stall":
			return {
				type: "tool-stall",
				callId: String(p.callId),
				name: String(p.name),
				elapsedMs: Number(p.elapsedMs),
				lastChunkMs: Number(p.lastChunkMs),
			};
		case "llm.tool-validation-error":
			return {
				type: "tool-validation-error",
				callId: String(p.callId),
				field: String(p.field),
				message: String(p.message),
			};
		case "llm.token-usage":
			return { type: "token-usage", usage: p.usage as TokensConsumed };
		case "llm.turn-error":
			return { type: "turn-error", message: String(p.message) };
		case "agent.run.inner": {
			const inner = p as { callId?: string; innerType?: string; innerPayload?: Record<string, unknown> };
			if (!inner.innerType || !inner.callId) return null;
			if (inner.innerType === "agent.identity" && inner.innerPayload) {
				return {
					type: "subagent-identity",
					callId: String(inner.callId),
					color: typeof inner.innerPayload.color === "string" ? inner.innerPayload.color : "",
					address: typeof inner.innerPayload.address === "string" ? inner.innerPayload.address : "",
				};
			}
			if (inner.innerType === "llm.tool-start" && inner.innerPayload) {
				const ip = inner.innerPayload;
				return {
					type: "inner-tool-start",
					parentCallId: String(inner.callId),
					callId: typeof ip.callId === "string" ? ip.callId : "",
					name: typeof ip.name === "string" ? ip.name : "",
					args: (ip.args ?? {}) as Record<string, unknown>,
				};
			}
			if (inner.innerType === "llm.tool-end" && inner.innerPayload) {
				const ip = inner.innerPayload;
				return {
					type: "inner-tool-end",
					parentCallId: String(inner.callId),
					callId: typeof ip.callId === "string" ? ip.callId : "",
				};
			}
			if (inner.innerType === "llm.chunk" && inner.innerPayload) {
				const chunkText = inner.innerPayload.text;
				return {
					type: "inner-chunk",
					parentCallId: String(inner.callId),
					text: typeof chunkText === "string" ? chunkText : "",
				};
			}
			return null;
		}
		case "llm.message-queued":
			return { type: "message-queued", queueLength: Number(p.queueLength ?? 0) };
		case "workflow.step":
			return {
				type: "workflow-step",
				workflowId: typeof p.workflowId === "string" ? p.workflowId : "",
				eventType: typeof p.eventType === "string" ? p.eventType : "",
				step: typeof p.step === "string" ? p.step : "",
				status: typeof p.status === "string" ? p.status : "",
				score: p.score !== undefined ? Number(p.score) : undefined,
			};
		case "workflow.completed":
			return {
				type: "workflow-completed",
				workflowId: typeof p.workflowId === "string" ? p.workflowId : "",
				elapsedMs: Number(p.elapsedMs ?? 0),
			};
		case "workflow.error":
			return {
				type: "workflow-error",
				workflowId: typeof p.workflowId === "string" ? p.workflowId : "",
				step: typeof p.step === "string" ? p.step : "",
				error: typeof p.error === "string" ? p.error : "",
			};
		case "workflow.escalated":
			return {
				type: "workflow-escalated",
				workflowId: typeof p.workflowId === "string" ? p.workflowId : "",
				rule: typeof p.rule === "string" ? p.rule : "",
				retries: p.retries !== undefined ? Number(p.retries) : undefined,
				score: p.score !== undefined ? Number(p.score) : undefined,
			};
		case "task.progress":
			return {
				type: "task-progress",
				taskId: typeof p.taskId === "string" ? p.taskId : "",
				chunk: typeof p.chunk === "string" ? p.chunk : "",
			};
		case "task.completed":
			return {
				type: "task-completed",
				taskId: typeof p.taskId === "string" ? p.taskId : "",
				profile: typeof p.profile === "string" ? p.profile : "",
				reply: typeof p.reply === "string" ? p.reply : "",
				elapsedMs: Number(p.elapsedMs ?? 0),
			};
		case "task.failed":
			return {
				type: "task-failed",
				taskId: typeof p.taskId === "string" ? p.taskId : "",
				profile: typeof p.profile === "string" ? p.profile : "",
				error: typeof p.error === "string" ? p.error : "",
				elapsedMs: Number(p.elapsedMs ?? 0),
			};
		default: {
			const mapper = adapterSignalMaps.get(event.type);
			if (mapper) {
				const mapped = mapper(p);
				if (mapped) return { type: "organ-signal", signalType: event.type, payload: mapped };
				return null;
			}
			if (tuiSignalHandlers.has(event.type)) {
				return { type: "organ-signal", signalType: event.type, payload: p };
			}
			return null;
		}
	}
}

function registerContributions(
	adapters: readonly {
		contributions?: { "signal.map"?: Readonly<Record<string, SignalMapper>>; tui?: TuiContribution };
	}[],
): void {
	registerAdapterSignalMaps(adapters);
	registerTuiSignals(adapters);
	tuiSignalHandlers.set("context.compacted", (payload, ui) => {
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

function connectObservers(agent: Agent, observers: Set<(event: AgentEvent) => void>): void {
	agent.observe({
		onCommand(event) {
			if (event.type === "llm.response") {
				const p = (event as { payload?: Record<string, unknown> }).payload ?? {};
				const text = typeof p.text === "string" ? p.text : "";
				for (const obs of observers) obs({ type: "turn-complete", reply: text });
			}
		},
		onEvent() {},
		onNotification(event) {
			const agentEvent = signalToAgentEvent(event);
			if (agentEvent) for (const obs of observers) obs(agentEvent);
		},
	});
}

export async function createLocalSession(
	args: Args,
	cfg: AlefConfig,
	log: Logger,
	store: SessionStore,
	loaded: AdapterLoadResult,
	model: Model<Api>,
): Promise<{
	session: SessionHandle;
	resolvedModelDisplay: string;
	humanAddress: string;
	agentAddress: string;
	actorRoutes: ActorRouteTable;
}> {
	const { organs: adapters, blueprintSurfaces } = loaded;
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

	let stack: { organs: Adapter[]; pipeline?: ReturnType<typeof createContextAssemblyPipeline> };
	if (stackFactory) {
		stack = await stackFactory({
			cwd: args.cwd,
			model,
			getSignal: () => llmController?.signal,
			sessionStore: store,
			domainOrgans: adapters,
			subagentFactory,
			writableRoots: loaded.writableRoots,
		});
	} else {
		const pipeline = createContextAssemblyPipeline();
		stack = { organs: adapters, pipeline };
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

	const { getDatabase, SqliteSummaryStore } = await import("@dpopsuev/alef-storage");
	const db = await getDatabase();
	const summaryStore = new SqliteSummaryStore(db);

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

	const sessionForum = new SqliteDiscourseStore(db, store.id);
	const controller = new AgentController(agent, {
		onReply: replySink,
		transcript: { store: sessionForum, topic: "sessions", thread: store.id },
	});

	actorRoutes.register(agentActor.color, async (message, timeout) => {
		await controller.send(message, "human", timeout);
	});

	for (const adapter of stack.organs) agent.load(adapter);

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
	await setupHttpSurface(args, agent, sessionAdapter, blueprintSurfaces);

	const alefAdapter = createMetaOrgan({
		agent: {
			load: (o: Adapter) => agent.load(o),
			unload: (n: string) => agent.unload(n),
			get adapters() {
				return agent.organs;
			},
		},
		loadAdapter: (path: string, cwd: string) => loadOrganFromPath(path, { cwd }),
		cwd: args.cwd,
		dialogEventType: "llm.input",
		onRebuildRequest: () => {
			const trigger = (globalThis as Record<string, unknown>).alefRequestRebuild;
			if (typeof trigger === "function") (trigger as () => void)();
		},
	});
	agent.load(alefAdapter);

	connectObservers(agent, observers);

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
	};
}
