import { Agent } from "@dpopsuev/alef-engine/agent";
import { buildAdapterDirectives, createToolShellAdapter } from "@dpopsuev/alef-engine/catalog";
import { AgentController } from "@dpopsuev/alef-engine/controller";
import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import type { AgentBus, BusMessage } from "@dpopsuev/alef-kernel/bus";
import type { AgentEvent, TokensConsumed } from "./session.js";

export type SignalMapper = (payload: Record<string, unknown>) => Record<string, unknown> | null;

export interface AgentServerOptions {
	llm: Adapter;
	adapters: readonly Adapter[];
	pipeline?: Adapter;
	onReply?: (text: string) => void;
	extraAdapters?: readonly Adapter[];
	signalMappers?: ReadonlyMap<string, SignalMapper>;
	uiSignalTypes?: ReadonlySet<string>;
	toolDisclosure?: "full" | "progressive";
	bus?: AgentBus;
}

export interface AgentServer {
	readonly agent: Agent;
	readonly controller: AgentController;
	readonly observers: Set<(event: AgentEvent) => void>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

/** Safely extract payload from a bus event (BusMessage base type has no payload; concrete subtypes do). */
function busPayload(event: BusMessage): Record<string, unknown> {
	if ("payload" in event) {
		const raw: unknown = (event as Record<string, unknown>)["payload"]; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- BusMessage concrete subtypes carry payload
		if (typeof raw === "object" && raw !== null) return raw as Record<string, unknown>; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- narrowed by typeof+null check
	}
	return {};
}

export function signalToAgentEvent(
	event: BusMessage,
	signalMappers?: ReadonlyMap<string, SignalMapper>,
	uiSignalTypes?: ReadonlySet<string>,
): AgentEvent | null {
	const p = busPayload(event);
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
				args: isRecord(p.args) ? p.args : {},
			};
		case "llm.tool-end":
			return {
				type: "tool-end",
				callId: String(p.callId),
				elapsedMs: Number(p.elapsedMs),
				ok: Boolean(p.ok),
				display: typeof p.display === "string" ? p.display : undefined,
				displayKind: typeof p.displayKind === "string" ? p.displayKind : undefined,
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
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- bus payload shape guaranteed by llm adapter
			return { type: "token-usage", usage: p.usage as TokensConsumed };
		case "llm.turn-error":
			return { type: "turn-error", message: String(p.message) };
		case "agent.run.inner": {
			const innerCallId = typeof p.callId === "string" ? p.callId : undefined;
			const innerType = typeof p.innerType === "string" ? p.innerType : undefined;
			const innerPayload = isRecord(p.innerPayload) ? p.innerPayload : undefined;
			if (!innerType || !innerCallId) return null;
			if (innerType === "agent.identity" && innerPayload) {
				return {
					type: "subagent-identity",
					callId: innerCallId,
					color: typeof innerPayload.color === "string" ? innerPayload.color : "",
					address: typeof innerPayload.address === "string" ? innerPayload.address : "",
				};
			}
			if (innerType === "llm.tool-start" && innerPayload) {
				return {
					type: "inner-tool-start",
					parentCallId: innerCallId,
					callId: typeof innerPayload.callId === "string" ? innerPayload.callId : "",
					name: typeof innerPayload.name === "string" ? innerPayload.name : "",
					args: isRecord(innerPayload.args) ? innerPayload.args : {},
				};
			}
			if (innerType === "llm.tool-end" && innerPayload) {
				return {
					type: "inner-tool-end",
					parentCallId: innerCallId,
					callId: typeof innerPayload.callId === "string" ? innerPayload.callId : "",
				};
			}
			if (innerType === "llm.chunk" && innerPayload) {
				return {
					type: "inner-chunk",
					parentCallId: innerCallId,
					text: typeof innerPayload.text === "string" ? innerPayload.text : "",
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
			if (signalMappers) {
				const mapper = signalMappers.get(event.type);
				if (mapper) {
					const mapped = mapper(p);
					if (mapped) return { type: "adapter-signal", signalType: event.type, payload: mapped };
					return null;
				}
			}
			if (uiSignalTypes?.has(event.type)) {
				return { type: "adapter-signal", signalType: event.type, payload: p };
			}
			return null;
		}
	}
}

export function connectObservers(
	agent: Agent,
	observers: Set<(event: AgentEvent) => void>,
	signalMappers?: ReadonlyMap<string, SignalMapper>,
	uiSignalTypes?: ReadonlySet<string>,
): void {
	agent.observe({
		onCommand(event) {
			if (event.type === "llm.response") {
				const p = busPayload(event);
				const text = typeof p.text === "string" ? p.text : "";
				for (const obs of observers) obs({ type: "turn-complete", reply: text });
			}
		},
		onEvent() {},
		onNotification(event) {
			const agentEvent = signalToAgentEvent(event, signalMappers, uiSignalTypes);
			if (agentEvent) for (const obs of observers) obs(agentEvent);
		},
	});
}

export function assembleAgentServer(opts: AgentServerOptions): AgentServer {
	const agent = new Agent({ bus: opts.bus });
	const observers = new Set<(event: AgentEvent) => void>();

	agent.load(opts.llm);

	const allAdapters = [...opts.adapters, ...(opts.extraAdapters ?? [])];
	const toolShell = createToolShellAdapter({
		tools: allAdapters.flatMap((o) => o.tools),
		getTools: () => agent.tools,
		adapterDirectives: buildAdapterDirectives(allAdapters),
		disclosure: opts.toolDisclosure ?? "full",
	});
	agent.load(toolShell);
	if (opts.pipeline) agent.load(opts.pipeline);
	for (const adapter of allAdapters) agent.load(adapter);

	const controller = new AgentController(agent, {
		onReply: opts.onReply,
	});

	connectObservers(agent, observers, opts.signalMappers, opts.uiSignalTypes);

	return { agent, controller, observers };
}
