import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { blueprintRegistry, loadOrganFromPath } from "@dpopsuev/alef-agent-blueprint";
import type { NerveEvent, Organ } from "@dpopsuev/alef-kernel";
import type { Api, Model, ThinkingLevel } from "@dpopsuev/alef-llm";
import { DialogOrgan } from "@dpopsuev/alef-organ-dialog";
import { createMetaOrgan } from "@dpopsuev/alef-organ-meta";
import { buildBootCatalog } from "@dpopsuev/alef-organ-toolshell";
import type { Logger } from "pino";
import { buildAgent } from "./agent-kernel.js";
import type { Args } from "./args.js";
import { setupHttpSurface } from "./build-delegation.js";
import { buildLlmOrgan } from "./build-llm-organ.js";
import type { AlefConfig } from "./config.js";
import { configureSessionActors } from "./identity/actor.js";
import { ActorRouteTable } from "./identity/routes.js";
import type { LoadResult } from "./load-organs.js";
import { createDefaultDirectives, loadWorkspace, registerOrgans } from "./prompt.js";
import type { AgentEvent, Session, SessionState, TokensConsumed } from "./session.js";
import { SessionHandle } from "./session-handle.js";
import type { SessionStore } from "./session-store.js";
import { makeSink } from "./sink.js";
import { buildSubagentFactory } from "./subagent-factory.js";
import { getTheme, setTheme } from "./theme.js";

function signalToAgentEvent(event: NerveEvent): AgentEvent | null {
	const p = (event as { payload?: Record<string, unknown> }).payload ?? {};
	switch (event.type) {
		case "llm.chunk":
			return { type: "chunk", text: String(p.text ?? "") };
		case "llm.thinking":
			return { type: "thinking", text: String(p.text ?? "") };
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
			return { type: "tool-chunk", callId: String(p.callId), text: String(p.text ?? "") };
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
					color: String(inner.innerPayload.color ?? ""),
					address: String(inner.innerPayload.address ?? ""),
				};
			}
			if (inner.innerType === "llm.tool-start" && inner.innerPayload) {
				const ip = inner.innerPayload;
				return {
					type: "inner-tool-start",
					parentCallId: String(inner.callId),
					callId: String(ip.callId ?? ""),
					name: String(ip.name ?? ""),
					args: (ip.args ?? {}) as Record<string, unknown>,
				};
			}
			if (inner.innerType === "llm.tool-end" && inner.innerPayload) {
				const ip = inner.innerPayload;
				return {
					type: "inner-tool-end",
					parentCallId: String(inner.callId),
					callId: String(ip.callId ?? ""),
				};
			}
			return null;
		}
		case "llm.message-queued":
			return { type: "message-queued", queueLength: Number(p.queueLength ?? 0) };
		default:
			return null;
	}
}

export async function createLocalSession(
	args: Args,
	cfg: AlefConfig,
	log: Logger,
	store: SessionStore,
	loaded: LoadResult,
	model: Model<Api>,
	trace: (event: string, extra?: Record<string, unknown>) => void,
): Promise<{
	session: SessionHandle;
	resolvedModelDisplay: string;
	humanAddress: string;
	agentAddress: string;
	actorRoutes: ActorRouteTable;
}> {
	const { organs, blueprintSurfaces } = loaded;

	const directives = createDefaultDirectives({ tools: organs.flatMap((o) => o.tools), cwd: args.cwd });
	await loadWorkspace(directives, args.cwd);
	registerOrgans(directives, organs);

	if (args.debug) {
		const skillPath = join(homedir(), ".config/opencode/skills/debug-alef/SKILL.md");
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

	const CONTEXT_FRACTION = 0.1;
	const CHARS_PER_TOKEN = 4;
	const directivesBudgetChars = Math.floor(model.contextWindow * CONTEXT_FRACTION * CHARS_PER_TOKEN);
	const thinkingState = {
		level: (args.thinking ?? cfg.thinking ?? (model.reasoning ? "medium" : undefined)) as ThinkingLevel | undefined,
	};

	const dialog = new DialogOrgan({
		sink: !args.print && !args.json && !args.noTui && process.stdin.isTTY ? () => {} : makeSink(args.json),
	});

	const sessionState: SessionState = { id: store.id, modelId: model.id, contextWindow: model.contextWindow };

	const boardId = store.id.slice(0, 12);
	const { humanActor, agentActor, theme } = configureSessionActors(store.id, boardId);
	setTheme({ ...getTheme(), ...theme });

	// Build the route table — the TUI uses this for @ routing.
	const actorRoutes = new ActorRouteTable();
	actorRoutes.setHumanAddress(humanActor.color);

	const observers = new Set<(event: AgentEvent) => void>();
	let llmController: AbortController | undefined;
	const currentModel = model;

	const stackFactory = blueprintRegistry.resolve(loaded.blueprintName);
	if (!stackFactory)
		throw new Error(
			`No blueprint registered for '${loaded.blueprintName ?? "(default)"}'. Import the agent package.`,
		);

	const subagentFactory = buildSubagentFactory({ model, trackConcurrentOps: true, forwardToolChunks: true });
	const stack = await stackFactory({
		cwd: args.cwd,
		model,
		getSignal: () => llmController?.signal,
		sessionStore: store,
		domainOrgans: organs,
		subagentFactory,
		writableRoots: loaded.writableRoots,
	});
	const { pipeline } = stack;

	const systemPrompt = directives.build(directivesBudgetChars);
	const enabledBlocks = directives.list({ enabled: true });
	log.info(
		{
			blocks: enabledBlocks.length,
			chars: systemPrompt.length,
			tags: [...new Set(enabledBlocks.flatMap((b) => b.tags ?? []))],
		},
		"directives:built",
	);

	const llmOrgan = buildLlmOrgan({
		model,
		cfg,
		args,
		thinkingState,
		getModel: () => currentModel,
		getSignal: () => llmController?.signal,
		schemaResolver: (name) => pipeline.getSchemaResolver()?.(name),
		systemPrompt,
	});

	const { agent } = buildAgent({
		dialog,
		llm: llmOrgan,
		session: store,
		modelId: model.id,
		agentIdentity: agentActor,
		onLoop: (_type, reason) => {
			trace("loop:detected", { reason });
			llmController?.abort(new Error(`[loop-detector] ${reason}`));
		},
	});

	// Register the main agent route — @agentcolor sends to dialog.send()
	actorRoutes.register(agentActor.color, async (message, timeout) => {
		await dialog.send(message, "human", timeout);
	});

	for (const organ of stack.organs) agent.load(organ);

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
		receive: (text: string) => dialog.receive(text, "user"),
		subscribe: (obs: (event: AgentEvent) => void) => {
			observers.add(obs);
			return () => observers.delete(obs);
		},
	};
	await setupHttpSurface(args, agent, sessionAdapter, blueprintSurfaces);

	const alefOrgan = createMetaOrgan({
		agent: {
			load: (o: Organ) => agent.load(o),
			unload: (n: string) => agent.unload(n),
			get organs() {
				return agent.organs;
			},
		},
		loadOrgan: (path: string, cwd: string) => loadOrganFromPath(path, { cwd }),
		cwd: args.cwd,
		dialogEventType: "llm.input",
		onRebuildRequest: () => {
			const trigger = (globalThis as Record<string, unknown>).alefRequestRebuild;
			if (typeof trigger === "function") trigger();
		},
	});
	agent.load(alefOrgan as Organ);

	agent.observe({
		onMotorEvent(event) {
			if (event.type === "llm.response") {
				const p = (event as { payload?: Record<string, unknown> }).payload ?? {};
				const text = typeof p.text === "string" ? p.text : "";
				for (const obs of observers) obs({ type: "turn-complete", reply: text });
			}
		},
		onSenseEvent() {},
		onSignalEvent(event) {
			const agentEvent = signalToAgentEvent(event);
			if (agentEvent) for (const obs of observers) obs(agentEvent);
		},
	});

	directives.register({
		id: "tool-shell.boot-catalog",
		priority: 900,
		content: () => buildBootCatalog(agent.tools),
		enabled: true,
		tags: ["organ", "dynamic"],
	});

	agent.validate();
	await agent.ready();

	const handle = new SessionHandle({
		state: sessionState,
		model,
		thinkingState,
		dialog,
		agent,
		directives,
		args,
		log,
		observers,
	});
	if (llmController) handle.setTurnController(llmController);

	const resolvedModelDisplay =
		model.name !== model.id ? `${model.provider}/${model.id} (${model.name})` : `${model.provider}/${model.id}`;

	return {
		session: handle,
		resolvedModelDisplay,
		humanAddress: humanActor.address, // "@dpopsuev"
		agentAddress: agentActor.address, // "@crimson"
		actorRoutes,
	};
}
