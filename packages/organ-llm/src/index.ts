import type { Nerve, Organ, OrganContributions, SenseHandlerCtx, ToolDefinition } from "@dpopsuev/alef-kernel";
import { defineOrgan, extractToolCallId, withDisplay } from "@dpopsuev/alef-kernel";
import type { Api, Message, Model, ThinkingLevel } from "@dpopsuev/alef-llm";

declare module "@dpopsuev/alef-kernel" {
	interface OrganContributions {
		"llm.phase"?: PhaseStageHandler;
	}
}

/**
 * Payload field names used to extract a human-readable key argument from a
 * tool call — shown in TUI pills and in the concurrent-ops context block.
 * Lives here (not in spine) because it is a presentation hint, not a bus primitive.
 * runner/src/tui imports this; organs themselves never reference it.
 */
export const KEY_ARG_FIELDS = [
	"command",
	"path",
	"url",
	"pattern",
	"glob",
	"symbol",
	"query",
	"text",
	"code",
	"instruction",
] as const;

import { z } from "zod";
import type { LlmEvent, TokenUsage } from "./tool-events.js";
import { runLLMLoop } from "./turn-loop.js";

export { payloadToText } from "./tool-dispatch.js";

/** Core execution options — model identity, auth, retry, timeout. */
export interface LlmCallOptions {
	model: Model<Api>;
	getModel?: () => Model<Api>;
	apiKey?: string;
	getApiKey?: () => string | undefined;
	timeoutMs?: number;
	maxRetries?: number;
	maxRetryDelayMs?: number;
	onRetry?: (attempt: number, reason: string) => void;
	getSignal?: () => AbortSignal | undefined;
}

export type { LlmEvent } from "./tool-events.js";

export interface LlmObservabilityOptions {
	onEvent?: (event: LlmEvent) => void;
	onTurnComplete?: (turn: number, usage: TokenUsage) => void;
}

/** Topology and capability options — routing, pipeline, concurrency, context prep. */
export interface LlmTopologyOptions {
	thinking?: ThinkingLevel;
	/** Live getter — overrides `thinking` when provided. Enables :think runtime switching. */
	getThinking?: () => ThinkingLevel | undefined;
	prepareStep?: (messages: Message[]) => Message[] | Promise<Message[]>;
	trackConcurrentOps?: boolean;
	phaseTimeoutMs?: number;

	/** Full-schema resolver for timeout calculation. Provided by ToolShell via contributions["schema-resolver"]. */
	schemaResolver?: (toolName: string) => ToolDefinition | undefined;
	/**
	 * System prompt injected as the first message when prepareStep is absent.
	 * In production prepareStep owns system prompt injection; this covers
	 * InProcessStrategy and eval harnesses that run without prepareStep.
	 */
	systemPrompt?: string;
}

/** Full options — intersection of all three groups. All existing callers still compile. */
export type AgentLoopOptions = LlmCallOptions & LlmObservabilityOptions & LlmTopologyOptions;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const LLM_INPUT = "llm.input";

export function createAgentLoopCore(options: AgentLoopOptions): Organ {
	let turnActive = false;
	const steeringBuffer: Message[] = [];

	return defineOrgan("llm", {
		sense: {
			[LLM_INPUT]: {
				handle: async (ctx: SenseHandlerCtx) => {
					if (turnActive) {
						const text = typeof ctx.payload.text === "string" ? ctx.payload.text : "";
						if (text) {
							steeringBuffer.push({ role: "user", content: text, timestamp: Date.now() });
							options.onEvent?.({ type: "message-queued", queueLength: steeringBuffer.length });
						}
						return;
					}
					turnActive = true;
					let partialHistory: Message[] | undefined;
					const offCheckpoint = ctx.motor.subscribe("llm.checkpoint", (event) => {
						const history = (event.payload as { conversationHistory?: Message[] }).conversationHistory;
						if (history) partialHistory = history;
					});
					try {
						await runLLMLoop(ctx, {
							...options,
							getSteeringMessages: () => steeringBuffer.splice(0),
						});
					} catch (err) {
						const text = `LLM error: ${String(err)}`;
						ctx.motor.publish({
							type: "llm.response",
							payload: withDisplay(
								{
									text,
									...(partialHistory ? { conversationHistory: partialHistory } : {}),
								},
								{ text: `\u26a0 ${text}`, mimeType: "text/plain" },
							),
							correlationId: ctx.correlationId,
						});
					} finally {
						offCheckpoint();
						turnActive = false;
					}
				},
			},
		},
	});
}

/** Entry tracked while a concurrent turn's tool call is in flight. */
interface InflightEntry {
	type: string;
	correlationId: string;
	startedAt: number;
	keyArg: string;
}

// Event types excluded from in-flight concurrent-turn tracking.
// The reply event signals turn completion, not an in-flight op.
function makeInflightExcluded(replyType: string): Set<string> {
	return new Set([replyType, "llm.phase", "llm.result"]);
}

function inflightKey(type: string, correlationId: string, toolCallId: string | undefined): string {
	return `${type}::${correlationId}::${toolCallId ?? ""}`;
}

function pickKeyArg(payload: Record<string, unknown>): string {
	for (const k of KEY_ARG_FIELDS) {
		const v = payload[k];
		if (typeof v === "string" && v.length > 0) return v.slice(0, 80);
	}
	return "";
}

/**
 * Create a full LLM organ with optional concurrent-ops inflight tracking.
 * createAgentLoop is the canonical factory.
 */
export function createAgentLoop(options: AgentLoopOptions): Organ {
	const replyType = "llm.response";
	const inflight = new Map<string, InflightEntry>();

	function applyInflightContext<T extends { role: string; content: string }>(messages: T[]): T[] {
		if (inflight.size === 0) return messages;
		const now = Date.now();
		const lines = [...inflight.values()].map((e) => {
			const elapsed = Math.floor((now - e.startedAt) / 1000);
			const corr = e.correlationId.slice(0, 8);
			return `  - ${e.type} (${corr}, ${elapsed}s)${e.keyArg ? `: ${e.keyArg}` : ""}`;
		});
		const block = `\nPending operations:\n${lines.join("\n")}`;
		const sysIdx = messages.findIndex((m) => m.role === "system");
		if (sysIdx >= 0) {
			const updated = [...messages] as T[];
			updated[sysIdx] = { ...messages[sysIdx], content: messages[sysIdx].content + block };
			return updated;
		}
		return [{ role: "system", content: block.trimStart() } as unknown as T, ...messages];
	}

	const wrappedOptions: AgentLoopOptions = options.trackConcurrentOps
		? {
				...options,
				prepareStep: async (msgs: Message[]) => {
					const afterUser = options.prepareStep ? await options.prepareStep(msgs) : msgs;
					return applyInflightContext(afterUser as { role: string; content: string }[]) as Message[];
				},
			}
		: options;

	const innerOrgan = createAgentLoopCore(wrappedOptions);

	const publishSchemas = {
		motor: {
			[replyType]: z.object({
				text: z.string().min(1),
				conversationHistory: z.array(z.unknown()).optional(),
				usage: z.object({ totalTokens: z.number() }).passthrough().optional(),
			}),
			"llm.phase": z.object({
				messages: z.array(z.unknown()),
				turn: z.number().int().positive(),
				toolCount: z.number().int().nonnegative(),
			}),
			"llm.result": z.object({
				response: z.record(z.string().min(1), z.unknown()),
				toolCalls: z.array(z.object({ name: z.string(), args: z.record(z.string(), z.unknown()), id: z.string() })),
				turn: z.number().int().positive(),
			}),
		},
	};

	const baseSubscriptions = innerOrgan.subscriptions;
	const subscriptions = options.trackConcurrentOps
		? {
				motor: [...baseSubscriptions.motor, "*"] as readonly string[],
				sense: [...baseSubscriptions.sense, "*"] as readonly string[],
			}
		: baseSubscriptions;

	return {
		name: "llm",
		description: "LLM reasoning loop: calls the language model, dispatches tool calls, collects replies.",
		labels: ["llm", "reasoning", "ai"],
		tools: [],
		publishSchemas,
		subscriptions,
		mount(nerve: Nerve): () => void {
			const offOrgan = innerOrgan.mount(nerve);
			if (!options.trackConcurrentOps) return offOrgan;

			const inflightExcluded = makeInflightExcluded(replyType);
			const offMotor = nerve.motor.subscribe("*", (event) => {
				if (inflightExcluded.has(event.type)) return;
				const toolCallId = extractToolCallId(event.payload);
				inflight.set(inflightKey(event.type, event.correlationId, toolCallId), {
					type: event.type,
					correlationId: event.correlationId,
					startedAt: event.timestamp,
					keyArg: pickKeyArg(event.payload),
				});
			});
			const offSense = nerve.sense.subscribe("*", (event) => {
				const toolCallId = extractToolCallId(event.payload);
				inflight.delete(inflightKey(event.type, event.correlationId, toolCallId));
			});

			return () => {
				offOrgan();
				offMotor();
				offSense();
				inflight.clear();
			};
		},
	};
}

export type { ToolDefinition };
export type { TokenUsage, ToolCallEnd, ToolCallStart } from "./tool-events.js";

// ---------------------------------------------------------------------------
// Ordered-pipeline — Chain of Responsibility for llm.phase
// ---------------------------------------------------------------------------

export interface PhaseStageInput {
	messages: Message[];
	tools: ToolDefinition[];
	turn: number;
}

export interface PhaseStageOutput {
	messages?: Message[];
	tools?: ToolDefinition[];
	skip?: boolean;
	reply?: string;
	abort?: boolean;
}

export type PhaseStageHandler = (input: PhaseStageInput) => Promise<PhaseStageOutput>;

export function createLlmPipeline(): Organ & {
	getSchemaResolver(): ((toolName: string) => ToolDefinition | undefined) | undefined;
} {
	const stages: PhaseStageHandler[] = [];
	const schemaResolvers = new Map<string, (toolName: string) => ToolDefinition | undefined>();

	return {
		name: "llm.pipeline",
		tools: [],
		subscriptions: { motor: ["llm.phase"], sense: ["organ.loaded"] },
		description:
			"Ordered llm.phase pipeline — self-assembles PhaseStageHandler and schema-resolver contributions from sense/organ.loaded.",
		getSchemaResolver() {
			if (schemaResolvers.size === 0) return undefined;
			return (toolName: string) => {
				for (const resolver of schemaResolvers.values()) {
					const def = resolver(toolName);
					if (def) return def;
				}
				return undefined;
			};
		},
		mount(nerve: Nerve): () => void {
			const unsubLoaded = nerve.sense.subscribe("organ.loaded", (event) => {
				const contributions = event.payload.contributions as OrganContributions | undefined;
				const name = event.payload.name as string;
				if (contributions?.["llm.phase"]) stages.push(contributions["llm.phase"]);
				if (contributions?.["schema-resolver"]) schemaResolvers.set(name, contributions["schema-resolver"]);
			});

			const unsubPhase = nerve.motor.subscribe("llm.phase", (event) => {
				void (async () => {
					const payload = event.payload as { messages: Message[]; tools?: ToolDefinition[]; turn: number };
					let messages: Message[] = payload.messages;
					let tools: ToolDefinition[] = payload.tools ?? [];

					for (const stage of stages) {
						const out = await stage({ messages, tools, turn: payload.turn });
						if (out.abort) {
							nerve.sense.publish({
								type: "llm.phase",
								correlationId: event.correlationId,
								payload: { abort: true },
								isError: false,
							});
							return;
						}
						if (out.messages) messages = out.messages;
						if (out.tools) tools = out.tools;
						if (out.skip) {
							nerve.sense.publish({
								type: "llm.phase",
								correlationId: event.correlationId,
								payload: { skip: true, reply: out.reply ?? "", messages, tools },
								isError: false,
							});
							return;
						}
					}

					nerve.sense.publish({
						type: "llm.phase",
						correlationId: event.correlationId,
						payload: { messages, tools },
						isError: false,
					});
				})();
			});

			return () => {
				unsubLoaded();
				unsubPhase();
			};
		},
	};
}
