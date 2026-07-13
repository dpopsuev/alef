import type { EventHandlerCtx, ToolDefinition } from "@dpopsuev/alef-kernel/adapter";
import { DEFAULT_TOOL_TIMEOUT_MS } from "@dpopsuev/alef-kernel/execution";
import { traceEvent } from "@dpopsuev/alef-kernel/log";
import { isContextOverflow } from "@dpopsuev/alef-ai/overflow";
import type { Api, Message, Model, ThinkingLevel } from "@dpopsuev/alef-ai/types";
import type { QueuedInput } from "./message-queue.js";
import { buildTools, prepareTurn } from "./handlers/message-handler.js";
import { applyPhaseResult, runPhase } from "./handlers/phase-handler.js";
import { publishReply, reportUsage } from "./handlers/response-handler.js";
import { appendToolResults } from "./handlers/tool-result-handler.js";
import { retryDelayMs, shouldRetry, sleep } from "./retry.js";
import { callLLM, type StreamRule } from "./stream-turn.js";
import { dispatchTools } from "./tool-dispatch.js";
import { createTurnSignals } from "./turn-signals.js";

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_MAX_RETRY_DELAY_MS = 8_000;
const ERROR_REASON_MAX_LENGTH = 80;
/** Minimum assemble window when recovering from overflow (even if phaseTimeoutMs is 0). */
const OVERFLOW_RECOVERY_PHASE_MS = 500;

// ---------------------------------------------------------------------------
// Options — structural subset of AgentLoopOptions, avoids circular import
// ---------------------------------------------------------------------------

/** Options for the multi-turn LLM loop — model, retry policy, phase pipeline, and lifecycle hooks. */
export interface TurnLoopOptions {
	model: Model<Api>;
	getModel?: () => Model<Api>;
	timeoutMs?: number;
	maxRetries?: number;
	maxRetryDelayMs?: number;
	onRetry?: (attempt: number, reason: string) => void;
	getSignal?: () => AbortSignal | undefined;
	thinking?: ThinkingLevel;
	getThinking?: () => ThinkingLevel | undefined;
	phaseTimeoutMs?: number;

	/** Full-schema resolver for timeout calculation. Provided by ToolShell via contributions["schema-resolver"]. */
	schemaResolver?: (toolName: string) => ToolDefinition | undefined;
	systemPrompt?: string;
	apiKey?: string;
	getApiKey?: () => string | undefined;
	/** Called immediately before the final command/llm.response is published — used to clear turn state. */
	onBeforeReply?: () => void;
	/** Drain steer queue at safe points (start of round + after tools). */
	getSteeringMessages?: () => QueuedInput[];
	/** True when steer queue still has items (check without draining). */
	hasSteeringMessages?: () => boolean;
	/** Stream-time regex rules — abort + enqueue steer on match. */
	streamRules?: readonly StreamRule[];
	/** Called when a stream rule matches (typically enqueues steer). */
	onStreamRuleMatch?: (rule: StreamRule) => void;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/** Run the multi-turn LLM loop: call model, dispatch tools, retry on transient errors, publish final reply. */
export async function runLLMLoop(ctx: EventHandlerCtx, options: TurnLoopOptions): Promise<void> {
	const payload = ctx.payload as {
		messages?: readonly unknown[];
		tools?: readonly { name: string; description: string; inputSchema: unknown }[];
		text?: string;
	};
	const { messages, tools, nameMap } = prepareTurn(payload);
	const toMotorName = (llmName: string): string => nameMap.get(llmName) ?? llmName;

	const { correlationId, bus } = ctx;
	const { command, event, notification: signal } = bus;
	const defaultTimeoutMs = DEFAULT_TOOL_TIMEOUT_MS;
	const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
	const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
	const maxRetryDelayMs = options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
	const turnSignals = createTurnSignals(event, signal, options.getSignal?.());
	const { effectiveSignal, callAbortControllers } = turnSignals;
	const effectiveOptions: TurnLoopOptions = { ...options, getSignal: () => effectiveSignal };

	let appRetryCount = 0;
	let turn = 0;
	let overflowRecoveryAttempted = false;

	try {
		// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- intentional infinite loop with break exits
		while (true) {
			turn++;
			injectSteering(messages, effectiveOptions.getSteeringMessages?.() ?? []);
			const model = effectiveOptions.getModel?.() ?? effectiveOptions.model;

			if (effectiveOptions.phaseTimeoutMs) {
				const phase = await runPhase(
					command,
					event,
					correlationId,
					messages,
					tools,
					turn,
					effectiveOptions.phaseTimeoutMs,
				);
				if (phase?.kind === "abort") break;
				if (phase?.kind === "skip") {
					command.publish({ type: "llm.response", payload: { text: phase.reply }, correlationId });
					break;
				}
				if (phase) applyPhaseResult(phase, messages, tools, nameMap, buildTools);
			}

			if (tools.length === 0 && turn === 1) {
				traceEvent("llm:zero-tools", { turn, phaseTimeout: effectiveOptions.phaseTimeoutMs });
			}

			const { finalMessage, pendingCalls, abortedByStreamRule } = await callLLM(
				model,
				messages,
				tools,
				turn,
				appRetryCount,
				{
					...effectiveOptions,
					command: command,
					notification: signal,
					correlationId,
					streamRules: effectiveOptions.streamRules,
					onStreamRuleMatch: effectiveOptions.onStreamRuleMatch,
				},
			);
			if (abortedByStreamRule) {
				injectSteering(messages, effectiveOptions.getSteeringMessages?.() ?? []);
				continue;
			}
			if (!finalMessage) break;

			if (shouldRetry(finalMessage, appRetryCount, maxRetries)) {
				appRetryCount++;
				effectiveOptions.onRetry?.(appRetryCount, finalMessage.errorMessage ?? "");
				traceEvent("llm:retry", {
					turn,
					attempt: appRetryCount,
					reason: finalMessage.errorMessage?.slice(0, ERROR_REASON_MAX_LENGTH) ?? "unknown",
				});
				await sleep(retryDelayMs(appRetryCount, maxRetryDelayMs));
				continue;
			}

			// Context overflow — force compact once, then retry the LLM call without publishing the error.
			if (isContextOverflow(finalMessage, model.contextWindow)) {
				if (!overflowRecoveryAttempted) {
					overflowRecoveryAttempted = true;
					signal.publish({
						type: "context.overflow-recovery",
						payload: { willRetry: true, errorMessage: finalMessage.errorMessage ?? "" },
						correlationId,
					});
					signal.publish({
						type: "context.compact.request",
						payload: { instructions: "Recover from context overflow; preserve goals, paths, and decisions." },
						correlationId,
					});
					traceEvent("llm:overflow-recovery", {
						turn,
						errorMessage: finalMessage.errorMessage?.slice(0, ERROR_REASON_MAX_LENGTH) ?? "overflow",
					});
					const phaseMs = Math.max(effectiveOptions.phaseTimeoutMs ?? 0, OVERFLOW_RECOVERY_PHASE_MS);
					const phase = await runPhase(command, event, correlationId, messages, tools, turn, phaseMs);
					if (phase?.kind === "abort") break;
					if (phase?.kind === "skip") {
						command.publish({ type: "llm.response", payload: { text: phase.reply }, correlationId });
						break;
					}
					if (phase) applyPhaseResult(phase, messages, tools, nameMap, buildTools);
					continue;
				}
				signal.publish({
					type: "context.overflow-recovery",
					payload: {
						willRetry: false,
						errorMessage:
							"Context overflow recovery failed after one compact-and-retry attempt. Try :compact or a larger-context model.",
					},
					correlationId,
				});
			}

			// Non-retryable LLM error — emit turn-error event to signal (telemetry, not a command).
			if (finalMessage.stopReason === "error") {
				const errorMsg = finalMessage.errorMessage ?? "LLM returned an error response";
				signal.publish({ type: "llm.turn-error", payload: { message: errorMsg }, correlationId });
				traceEvent("llm:turn:error", { turn, errorMessage: errorMsg });
			}

			messages.push(finalMessage);

			const toolCalls = pendingCalls;
			const agentIsReplying = toolCalls.length === 0;

			signal.publish({
				type: "llm.result",
				payload: {
					response: { ...finalMessage } satisfies Record<string, unknown>,
					toolCalls: toolCalls.map((tc) => ({ name: toMotorName(tc.name), args: tc.args, id: tc.id })),
					turn,
				},
				correlationId,
			});

			const usage = reportUsage(finalMessage);
			signal.publish({ type: "llm.token-usage", payload: { usage }, correlationId });

			if (agentIsReplying) {
				if (effectiveOptions.hasSteeringMessages?.()) {
					continue;
				}
				options.onBeforeReply?.();
				publishReply(command, correlationId, finalMessage, messages);
				break;
			}

			const toolDefsMap = new Map<string, ToolDefinition>();
			const results = await dispatchTools(command, signal, event, correlationId, toolCalls, toMotorName, timeoutMs, {
				...effectiveOptions,
				signal: effectiveSignal,
				toolDefs: toolDefsMap,
				callAbortControllers,
			});
			appendToolResults(messages, toolCalls, results, toMotorName);
			signal.publish({
				type: "llm.checkpoint",
				payload: { conversationHistory: messages.slice() },
				correlationId: ctx.correlationId,
			});
			injectSteering(messages, effectiveOptions.getSteeringMessages?.() ?? []);
		}
	} finally {
		turnSignals.dispose();
	}
}

/** Append drained steer payloads as user messages. */
function injectSteering(messages: Message[], steering: QueuedInput[]): void {
	for (const item of steering) {
		const text = typeof item.payload.text === "string" ? item.payload.text : "";
		if (!text) continue;
		messages.push({ role: "user", content: text, timestamp: Date.now() });
	}
}
