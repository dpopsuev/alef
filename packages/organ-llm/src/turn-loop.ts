import type { SenseEvent, SenseHandlerCtx, ToolDefinition } from "@dpopsuev/alef-kernel";
import { debugLog, toolInputToJsonSchema } from "@dpopsuev/alef-kernel";
import type { Api, AssistantMessage, Message, Model, ThinkingLevel, Tool } from "@dpopsuev/alef-llm";
import type { z } from "zod";
import { normalizeMessage, retryDelayMs, shouldRetry, sleep } from "./retry.js";
import { callLLM, type ToolCall } from "./stream-turn.js";
import { dispatchTools, payloadToText } from "./tool-dispatch.js";
import type { TokenUsage } from "./tool-events.js";

const DEFAULT_TOOL_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RETRIES = 4;
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
// Phase pipeline
// ---------------------------------------------------------------------------

export interface PhaseResult {
	messages?: Message[];
	tools?: ToolDefinition[];
	skip?: boolean;
	reply?: string;
	abort?: boolean;
}

const PHASE_PIPELINE_QUIESCENCE_MS = 30;

function parsePhaseResult(payload: Record<string, unknown>): PhaseResult {
	const p = payload as PhaseResult;
	return {
		messages: Array.isArray(p.messages) ? p.messages : undefined,
		tools: Array.isArray(p.tools) ? p.tools : undefined,
		skip: p.skip,
		reply: p.reply,
		abort: p.abort,
	};
}

function lastDefined<T>(stages: PhaseResult[], pick: (s: PhaseResult) => T | undefined): T | undefined {
	for (let i = stages.length - 1; i >= 0; i--) {
		const v = pick(stages[i] as PhaseResult);
		if (v !== undefined) return v;
	}
	return undefined;
}

function mergePhaseResults(stages: PhaseResult[]): PhaseResult | undefined {
	if (stages.length === 0) return undefined;
	return {
		messages: lastDefined(stages, (s) => s.messages),
		tools: lastDefined(stages, (s) => s.tools),
		skip: stages.some((s) => s.skip),
		reply: lastDefined(stages, (s) => s.reply),
		abort: stages.some((s) => s.abort),
	};
}

type SenseBus = SenseHandlerCtx["sense"];
type MotorBus = SenseHandlerCtx["motor"];

function waitForPhaseResult(
	sense: SenseBus,
	correlationId: string,
	timeoutMs: number,
): Promise<PhaseResult | undefined> {
	return new Promise((resolve) => {
		const collected: PhaseResult[] = [];
		let quiescenceTimer: ReturnType<typeof setTimeout> | undefined;

		const finish = () => {
			if (quiescenceTimer !== undefined) clearTimeout(quiescenceTimer);
			clearTimeout(deadlineTimer);
			off();
			resolve(mergePhaseResults(collected));
		};

		const deadlineTimer = setTimeout(finish, timeoutMs); // lint-ignore: RAWTIMER LLM phase pipeline deadline

		const off = sense.subscribe("context.assemble", (event) => {
			if (event.correlationId !== correlationId) return;
			collected.push(parsePhaseResult(event.payload));
			if (quiescenceTimer !== undefined) clearTimeout(quiescenceTimer);
			quiescenceTimer = setTimeout(finish, PHASE_PIPELINE_QUIESCENCE_MS); // lint-ignore: RAWTIMER quiescence window
		});
	});
}

// ---------------------------------------------------------------------------
// Turn-loop helpers
// ---------------------------------------------------------------------------

type ToolDef = { name: string; description: string; inputSchema: z.ZodTypeAny };

export function buildTools(defs: readonly ToolDef[], nameMap: Map<string, string>): Tool[] {
	const seen = new Set<string>();
	const tools: Tool[] = [];
	for (const t of defs) {
		const llmName = t.name.replace(/\./g, "_");
		if (seen.has(llmName)) continue;
		seen.add(llmName);
		nameMap.set(llmName, t.name);
		tools.push({ name: llmName, description: t.description, parameters: toolInputToJsonSchema(t.inputSchema) });
	}
	return tools;
}

interface TurnSetup {
	messages: Message[];
	tools: Tool[];
	nameMap: Map<string, string>;
}

function prepareTurn(payload: { messages?: readonly unknown[]; tools?: readonly ToolDef[]; text?: string }): TurnSetup {
	const rawMessages =
		payload.messages ?? (payload.text ? [{ role: "user", content: payload.text, timestamp: Date.now() }] : []);
	const nameMap = new Map<string, string>();
	const toolDefs = (payload.tools as readonly ToolDef[] | undefined) ?? [];
	const tools = buildTools(toolDefs, nameMap);
	const messages = (rawMessages as Message[]).map(normalizeMessage);
	return { messages, tools, nameMap };
}

function serializeConversationHistory(messages: Message[]): unknown[] {
	return messages
		.filter((m) => (m as { role?: string }).role !== "system")
		.map((m): unknown => {
			const msg = m as { role: string; content: unknown; toolCallId?: string; toolName?: string; isError?: boolean };
			if (msg.role === "toolResult") {
				return {
					role: "toolResult",
					toolCallId: msg.toolCallId,
					toolName: msg.toolName,
					content: msg.content,
					isError: msg.isError,
				};
			}
			return { role: msg.role, content: msg.content };
		});
}

function applyPhaseResult(phase: PhaseResult, messages: Message[], tools: Tool[], nameMap: Map<string, string>): void {
	if (phase.messages && phase.messages.length > 0) messages.splice(0, messages.length, ...phase.messages);
	if (phase.tools && phase.tools.length > 0)
		tools.splice(0, tools.length, ...buildTools(phase.tools as ToolDef[], nameMap));
}

function reportUsage(finalMessage: AssistantMessage): TokenUsage | undefined {
	if (!finalMessage.usage) return undefined;
	return {
		input: finalMessage.usage.input,
		output: finalMessage.usage.output,
		totalTokens: finalMessage.usage.totalTokens ?? finalMessage.usage.input + finalMessage.usage.output,
	};
}

function appendToolResults(
	messages: Message[],
	toolCalls: ToolCall[],
	results: SenseEvent[],
	toMotorName: (n: string) => string,
): void {
	for (const [toolCall, result] of toolCalls.map((tc, i) => [tc, results[i]] as const)) {
		messages.push({
			role: "toolResult",
			toolCallId: toolCall.id,
			toolName: toMotorName(toolCall.name),
			content: [{ type: "text", text: payloadToText(result.payload, result.isError, result.errorMessage) }],
			isError: result.isError,
			timestamp: Date.now(),
		});
	}
}

function extractText(message: AssistantMessage): string {
	return message.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("");
}

const LLM_RESPONSE = "llm.response";

function publishReply(
	motor: MotorBus,
	correlationId: string,
	finalMessage: AssistantMessage,
	messages: Message[],
): void {
	const text = extractText(finalMessage);
	if (text) {
		motor.publish({
			type: LLM_RESPONSE,
			payload: { text, conversationHistory: serializeConversationHistory(messages), usage: finalMessage.usage },
			correlationId,
		});
	} else {
		const fallback =
			finalMessage.errorMessage || (finalMessage.stopReason === "error" ? "An error occurred." : "(no response)");
		motor.publish({ type: LLM_RESPONSE, payload: { text: fallback }, correlationId });
	}
}

async function runPhase(
	motor: MotorBus,
	sense: SenseBus,
	correlationId: string,
	messages: Message[],
	tools: Tool[],
	turn: number,
	phaseTimeoutMs: number,
): Promise<PhaseResult | undefined> {
	const t0 = Date.now();
	debugLog("llm:phase:enter", { turn });
	const phasePromise = waitForPhaseResult(sense, correlationId, phaseTimeoutMs);
	motor.publish({
		type: "context.assemble",
		payload: { messages: messages as unknown[], turn, toolCount: tools.length },
		correlationId,
	});
	const phase = await phasePromise;
	debugLog("llm:phase:exit", { turn, elapsedMs: Date.now() - t0, modified: !!phase });
	return phase;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function runLLMLoop(ctx: SenseHandlerCtx, options: TurnLoopOptions): Promise<void> {
	const payload = ctx.payload as { messages?: readonly unknown[]; tools?: readonly ToolDef[]; text?: string };
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
	const userSignal = options.getSignal?.();
	const effectiveSignal = userSignal
		? AbortSignal.any([budgetController.signal, userSignal])
		: budgetController.signal;
	const effectiveOptions: TurnLoopOptions = { ...options, getSignal: () => effectiveSignal };

	let appRetryCount = 0;
	let turn = 0;

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
				if (phase?.abort) break;
				if (phase?.skip) {
					motor.publish({ type: LLM_RESPONSE, payload: { text: phase.reply ?? "(skipped)" }, correlationId });
					break;
				}
				if (phase) applyPhaseResult(phase, messages, tools, nameMap);
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
				toolDefs: toolDefsMap,
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
	}
}
