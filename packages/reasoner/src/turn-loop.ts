import type { SenseHandlerCtx, ToolDefinition } from "@dpopsuev/alef-kernel";
import { debugLog } from "@dpopsuev/alef-kernel";
import type { Api, Model, ThinkingLevel } from "@dpopsuev/alef-llm";
import { buildTools, prepareTurn } from "./handlers/message-handler.js";
import { applyPhaseResult, runPhase } from "./handlers/phase-handler.js";
import { publishReply, reportUsage } from "./handlers/response-handler.js";
import { appendToolResults } from "./handlers/tool-result-handler.js";
import { retryDelayMs, shouldRetry, sleep } from "./retry.js";
import { callLLM } from "./stream-turn.js";
import { dispatchTools } from "./tool-dispatch.js";

const DEFAULT_TOOL_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_MAX_RETRY_DELAY_MS = 8_000;

// ---------------------------------------------------------------------------
// Options — structural subset of AgentLoopOptions, avoids circular import
// ---------------------------------------------------------------------------

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
	/** Called immediately before the final motor/llm.response is published — used to clear turn state. */
	onBeforeReply?: () => void;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function runLLMLoop(ctx: SenseHandlerCtx, options: TurnLoopOptions): Promise<void> {
	const payload = ctx.payload as {
		messages?: readonly unknown[];
		tools?: readonly { name: string; description: string; inputSchema: unknown }[];
		text?: string;
	};
	const { messages, tools, nameMap } = prepareTurn(payload);
	const toMotorName = (llmName: string): string => nameMap.get(llmName) ?? llmName;

	const { correlationId, motor, sense, signal } = ctx;
	const defaultTimeoutMs = Number(process.env.ALEF_LLM_TIMEOUT_MS) || DEFAULT_TOOL_TIMEOUT_MS;
	const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
	const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
	const maxRetryDelayMs = options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
	const budgetController = new AbortController();
	const offBudget = sense.subscribe("budget.cancel", () => {
		budgetController.abort(new Error("[budget] maxElapsedMs exceeded"));
	});
	const offCancel = signal.subscribe("tools.cancel-request", (event) => {
		const callId = (event as { payload?: { callId?: string } }).payload?.callId;
		if (callId) callAbortControllers.get(callId)?.abort(new Error(`Cancelled by tools.cancel: ${callId}`));
	});
	const userSignal = options.getSignal?.();
	const effectiveSignal = userSignal
		? AbortSignal.any([budgetController.signal, userSignal])
		: budgetController.signal;
	const effectiveOptions: TurnLoopOptions = { ...options, getSignal: () => effectiveSignal };

	let appRetryCount = 0;
	let turn = 0;
	const callAbortControllers = new Map<string, AbortController>();

	try {
		while (true) {
			turn++;
			const model = effectiveOptions.getModel?.() ?? effectiveOptions.model;

			if (effectiveOptions.phaseTimeoutMs) {
				const phase = await runPhase(
					motor,
					sense,
					correlationId,
					messages,
					tools,
					turn,
					effectiveOptions.phaseTimeoutMs,
				);
				if (phase?.kind === "abort") break;
				if (phase?.kind === "skip") {
					motor.publish({ type: "llm.response", payload: { text: phase.reply }, correlationId });
					break;
				}
				if (phase) applyPhaseResult(phase, messages, tools, nameMap, buildTools);
			}

			const { finalMessage, pendingCalls } = await callLLM(model, messages, tools, turn, appRetryCount, {
				...effectiveOptions,
				motor,
				signal,
				correlationId,
			});
			if (!finalMessage) break;

			if (shouldRetry(finalMessage, appRetryCount, maxRetries)) {
				appRetryCount++;
				effectiveOptions.onRetry?.(appRetryCount, finalMessage.errorMessage ?? "");
				debugLog("llm:retry", {
					turn,
					attempt: appRetryCount,
					reason: finalMessage.errorMessage?.slice(0, 80) ?? "unknown",
				});
				await sleep(retryDelayMs(appRetryCount, maxRetryDelayMs));
				continue;
			}

			// Non-retryable LLM error — emit turn-error event to signal (telemetry, not a command).
			if (finalMessage.stopReason === "error") {
				const errorMsg = finalMessage.errorMessage ?? "LLM returned an error response";
				signal.publish({ type: "llm.turn-error", payload: { message: errorMsg }, correlationId });
				debugLog("llm:turn:error", { turn, errorMessage: errorMsg });
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
			if (usage && agentIsReplying) {
				signal.publish({ type: "llm.token-usage", payload: { usage }, correlationId });
			}

			if (agentIsReplying) {
				options.onBeforeReply?.();
				publishReply(motor, correlationId, finalMessage, messages);
				break;
			}

			const toolDefsMap = new Map<string, ToolDefinition>();
			const results = await dispatchTools(motor, signal, sense, correlationId, toolCalls, toMotorName, timeoutMs, {
				...effectiveOptions,
				signal: effectiveSignal,
				toolDefs: toolDefsMap,
				callAbortControllers,
			});
			appendToolResults(messages, toolCalls, results, toMotorName);
			signal.publish({
				type: "llm.checkpoint",
				payload: { conversationHistory: messages.slice() as unknown as Record<string, unknown>[] },
				correlationId: ctx.correlationId,
			});
		}
	} finally {
		offBudget();
		offCancel();
	}
}

// Re-export for backward compatibility
export { buildTools } from "./handlers/message-handler.js";
