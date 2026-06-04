import type { Api, Message, Model, ThinkingLevel } from "@dpopsuev/alef-ai";
import type { CerebrumHandlerCtx, Nerve, Organ, ToolDefinition } from "@dpopsuev/alef-spine";
import { DIALOG_MESSAGE, defineOrgan, extractToolCallId } from "@dpopsuev/alef-spine";
import { z } from "zod";
import type { CerebrumEvent, TokenUsage } from "./tool-events.js";
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

export type { CerebrumEvent } from "./tool-events.js";

export interface LlmObservabilityOptions {
	onEvent?: (event: CerebrumEvent) => void;
	onTurnComplete?: (turn: number, usage: TokenUsage) => void;
	onCheckpoint?: (messages: Message[], correlationId: string) => void;
}

/** Topology and capability options — routing, pipeline, concurrency, context prep. */
export interface LlmTopologyOptions {
	thinking?: ThinkingLevel;
	/** Live getter — overrides `thinking` when provided. Enables :think runtime switching. */
	getThinking?: () => ThinkingLevel | undefined;
	prepareStep?: (messages: Message[]) => Message[] | Promise<Message[]>;
	trackConcurrentOps?: boolean;
	phaseTimeoutMs?: number;
	triggerEvent?: string;
	replyEvent?: string;
	/**
	 * Live tool list getter. Takes precedence over payload.tools from the trigger event.
	 * Allows DialogOrgan to shed getTools — callers pass it directly to Cerebrum instead.
	 */
	getTools?: () => readonly ToolDefinition[];
	/**
	 * System prompt injected as the first message when prepareStep is absent.
	 * In production prepareStep owns system prompt injection; this covers
	 * InProcessStrategy and eval harnesses that run without prepareStep.
	 */
	systemPrompt?: string;
}

/** Full options — intersection of all three groups. All existing callers still compile. */
export type CerebrumOptions = LlmCallOptions & LlmObservabilityOptions & LlmTopologyOptions;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCerebrum(options: CerebrumOptions): Organ {
	const trigger = options.triggerEvent ?? DIALOG_MESSAGE;
	const reply = options.replyEvent ?? trigger;
	const isConversation = reply === DIALOG_MESSAGE;
	return defineOrgan("llm", {
		[`sense/${trigger}`]: {
			handle: async (ctx: CerebrumHandlerCtx) => {
				// Holds the last tool-round snapshot so partial history can be
				// published on abort/error, preventing conversation amnesia.
				let partialHistory: Message[] | undefined;
				try {
					await runLLMLoop(ctx, options, (snapshot, correlationId) => {
						partialHistory = snapshot;
						options.onCheckpoint?.(snapshot, correlationId);
					});
				} catch (err) {
					const text = `LLM error: ${String(err)}`;
					ctx.motor.publish({
						type: reply,
						payload: {
							text,
							...(isConversation && partialHistory ? { conversationHistory: partialHistory } : {}),
						},
						correlationId: ctx.correlationId,
					});
				}
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
	for (const k of ["command", "path", "url", "pattern", "glob", "symbol", "query"]) {
		const v = payload[k];
		if (typeof v === "string" && v.length > 0) return v.slice(0, 80);
	}
	return "";
}

/**
 * Create a full Cerebrum organ with optional concurrent-ops inflight tracking.
 * This is the canonical factory. The Cerebrum class below is a thin adapter
 * kept for backward compatibility with `new Cerebrum(opts)` call sites.
 */
export function createConcurrentCerebrum(options: CerebrumOptions): Organ {
	const replyType = options.replyEvent ?? options.triggerEvent ?? DIALOG_MESSAGE;
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

	const wrappedOptions: CerebrumOptions = options.trackConcurrentOps
		? {
				...options,
				prepareStep: async (msgs: Message[]) => {
					const afterUser = options.prepareStep ? await options.prepareStep(msgs) : msgs;
					return applyInflightContext(afterUser as { role: string; content: string }[]) as Message[];
				},
			}
		: options;

	const innerOrgan = createCerebrum(wrappedOptions);

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
				response: z.record(z.string(), z.unknown()),
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

/** Backward-compatible adapter. Prefer createConcurrentCerebrum for new code. */
export class Cerebrum implements Organ {
	private readonly _impl: Organ;

	constructor(options: CerebrumOptions) {
		this._impl = createConcurrentCerebrum(options);
	}

	get name() {
		return this._impl.name;
	}
	get description() {
		return this._impl.description;
	}
	get labels() {
		return this._impl.labels;
	}
	get tools() {
		return this._impl.tools;
	}
	get publishSchemas() {
		return this._impl.publishSchemas;
	}
	get subscriptions() {
		return this._impl.subscriptions;
	}
	mount(nerve: Nerve) {
		return this._impl.mount(nerve);
	}
}

export type { ToolDefinition };
// AI types and utilities — re-exported so callers don't import @dpopsuev/alef-ai directly.
export type {
	Api,
	AssistantMessage,
	KnownProvider,
	Message,
	Model,
	ThinkingLevel,
	UserMessage,
} from "@dpopsuev/alef-ai";
export { findEnvKeys, getEnvApiKey, getModels, getProviders } from "@dpopsuev/alef-ai";
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

export function createLlmPipeline(stages: PhaseStageHandler[]): Organ {
	return {
		name: "llm.pipeline",
		tools: [],
		subscriptions: { motor: ["llm.phase"], sense: [] },
		description: "Ordered llm.phase pipeline — runs PhaseStageHandlers serially, piping messages between stages.",
		mount(nerve: Nerve): () => void {
			return nerve.motor.subscribe("llm.phase", (event) => {
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
		},
	};
}
