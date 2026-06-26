import type { Adapter, EventHandlerCtx, ToolDefinition } from "@dpopsuev/alef-kernel/adapter";
import { defineAdapter, withDisplay } from "@dpopsuev/alef-kernel/adapter";
import type { Bus } from "@dpopsuev/alef-kernel/bus";
import { extractToolCallId } from "@dpopsuev/alef-kernel/bus";
import {
	type ActualConditions,
	computeError,
	type DesiredStateSpec,
	type DomainCondition,
	detectDrift,
	type ErrorTensor,
} from "@dpopsuev/alef-kernel/reconciliation";
import type { Api, Model, ThinkingLevel } from "@dpopsuev/alef-llm";

/**
 * Payload field names used to extract a human-readable key argument from a
 * tool call — shown in TUI pills and in the concurrent-ops context block.
 * Lives here (not in spine) because it is a presentation hint, not a bus primitive.
 * runner/src/tui imports this; adapters themselves never reference it.
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

export interface LlmObservabilityOptions {}

/** Topology and capability options — routing, pipeline, concurrency, context prep. */
export interface LlmTopologyOptions {
	thinking?: ThinkingLevel;
	/** Live getter — overrides `thinking` when provided. Enables :think runtime switching. */
	getThinking?: () => ThinkingLevel | undefined;
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

export function createAgentLoopCore(options: AgentLoopOptions): Adapter {
	let turnActive = false;

	return defineAdapter("llm", {
		event: {
			[LLM_INPUT]: {
				handle: async (ctx: EventHandlerCtx) => {
					if (turnActive) {
						const text = typeof ctx.payload.text === "string" ? ctx.payload.text : "";
						if (text) {
							ctx.bus.notification.publish({
								type: "llm.message-queued",
								payload: { text },
								correlationId: ctx.correlationId,
							});
						}
						return;
					}
					turnActive = true;
					let partialHistory: unknown[] | undefined;
					const offCheckpoint = ctx.bus.command.subscribe("llm.checkpoint", (event) => {
						const history = (event.payload as { conversationHistory?: unknown[] }).conversationHistory;
						if (history) partialHistory = history;
					});
					try {
						await runLLMLoop(ctx, {
							...options,
							onBeforeReply: () => {
								turnActive = false;
							},
						});
					} catch (err) {
						turnActive = false;
						const text = `LLM error: ${String(err)}`;
						ctx.bus.command.publish({
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
	return new Set([replyType, "context.assemble", "llm.result"]);
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
 * Create a full LLM adapter with optional concurrent-ops inflight tracking.
 * createAgentLoop is the canonical factory.
 */
export interface ReconciliationSurface {
	getActualConditions(): readonly ActualConditions[];
	getErrorTensor(): ErrorTensor | null;
	setDesiredState(dss: DesiredStateSpec): void;
	recompute(): ErrorTensor | null;
}

export function createAgentLoop(options: AgentLoopOptions): Adapter & ReconciliationSurface {
	const replyType = "llm.response";
	const inflight = new Map<string, InflightEntry>();
	const adapterConditions = new Map<string, ActualConditions>();
	let lastErrorTensor: ErrorTensor | null = null;
	let desiredState: DesiredStateSpec | null = null;

	function collectConditions(adapterId: string, conditions: readonly DomainCondition[]): void {
		adapterConditions.set(adapterId, {
			adapterId,
			conditions,
			healthy: true,
			observedAt: Date.now(),
		});
	}

	function getActualConditions(): readonly ActualConditions[] {
		return [...adapterConditions.values()];
	}

	function _applyInflightContext<T extends { role: string; content: string }>(messages: T[]): T[] {
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
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- constructing a system message with shape matching generic T
		return [{ role: "system", content: block.trimStart() } as unknown as T, ...messages];
	}

	const wrappedOptions: AgentLoopOptions = options;

	const innerAdapter = createAgentLoopCore(wrappedOptions);

	const publishSchemas = {
		command: {
			[replyType]: z.object({
				text: z.string().min(1),
				conversationHistory: z.array(z.unknown()).optional(),
				usage: z.object({ totalTokens: z.number() }).passthrough().optional(),
			}),
			"context.assemble": z.object({
				messages: z.array(z.unknown()),
				turn: z.number().int().positive(),
				toolCount: z.number().int().nonnegative(),
			}),
		},
	};

	const baseSubscriptions = innerAdapter.subscriptions;
	const subscriptions = options.trackConcurrentOps
		? {
				command: [...baseSubscriptions.command, "*"] as readonly string[],
				event: [...baseSubscriptions.event, "*"] as readonly string[],
				notification: [...baseSubscriptions.notification, "*"] as readonly string[],
			}
		: baseSubscriptions;

	return {
		name: "llm",
		description: "LLM reasoning loop: calls the language model, dispatches tool calls, collects replies.",
		labels: ["llm", "reasoning", "ai"],
		getActualConditions,
		getErrorTensor: () => lastErrorTensor,
		setDesiredState: (dss: DesiredStateSpec) => {
			desiredState = dss;
		},
		recompute: () => {
			if (!desiredState) return null;
			const prev = lastErrorTensor;
			lastErrorTensor = computeError(desiredState, getActualConditions());
			if (prev) {
				const drifted = detectDrift(prev, lastErrorTensor);
				if (drifted.length > 0) {
					lastErrorTensor = { ...lastErrorTensor, dimensions: [...lastErrorTensor.dimensions] };
				}
			}
			return lastErrorTensor;
		},
		tools: [],
		publishSchemas,
		subscriptions,
		sources: [],
		contributions: {
			port: { name: "reasoning", eventPattern: "event/llm.input", cardinality: "exactly-one" },
		},
		mount(bus: Bus): () => void {
			const offAdapter = innerAdapter.mount(bus);
			if (!options.trackConcurrentOps) return offAdapter;

			const inflightExcluded = makeInflightExcluded(replyType);
			const offMotor = bus.command.subscribe("*", (event) => {
				if (inflightExcluded.has(event.type)) return;
				const toolCallId = extractToolCallId(event.payload);
				inflight.set(inflightKey(event.type, event.correlationId, toolCallId), {
					type: event.type,
					correlationId: event.correlationId,
					startedAt: event.timestamp,
					keyArg: pickKeyArg(event.payload),
				});
			});
			const offSense = bus.event.subscribe("*", (event) => {
				const toolCallId = extractToolCallId(event.payload);
				inflight.delete(inflightKey(event.type, event.correlationId, toolCallId));
				if (event.conditions?.length) {
					const adapterId = event.type.split(".")[0] ?? event.type;
					collectConditions(adapterId, event.conditions);
				}
			});

			return () => {
				offAdapter();
				offMotor();
				offSense();
				inflight.clear();
			};
		},
	};
}

export type { ToolDefinition };
export type { TokenUsage, ToolCallEnd, ToolCallStart } from "./tool-events.js";
