import type { Api, AssistantMessage, Message, Model, ThinkingLevel, Tool } from "@dpopsuev/alef-ai";
import type { CerebrumHandlerCtx, SenseEvent, ToolDefinition } from "@dpopsuev/alef-kernel";
import { debugLog, toolInputToJsonSchema } from "@dpopsuev/alef-kernel";
import type { z } from "zod";
import { DIALOG_MESSAGE } from "./constants.js";
import { normalizeMessage, retryDelayMs, shouldRetry, sleep } from "./retry.js";
import { callLLM, type ToolCall } from "./stream-turn.js";
import { dispatchTools, payloadToText } from "./tool-dispatch.js";
import type { CerebrumEvent, TokenUsage } from "./tool-events.js";

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
	onEvent?: (event: CerebrumEvent) => void;
	onTurnComplete?: (turn: number, usage: TokenUsage) => void;
	thinking?: ThinkingLevel;
	getThinking?: () => ThinkingLevel | undefined;
	prepareStep?: (messages: Message[]) => Message[] | Promise<Message[]>;
	phaseTimeoutMs?: number;
	triggerEvent?: string;
	replyEvent?: string;
	getTools?: () => readonly ToolDefinition[];
	systemPrompt?: string;
	apiKey?: string;
	getApiKey?: () => string | undefined;
	/** Drain buffered steering messages — injected as user turns between tool batches. */
	getSteeringMessages?: () => Message[];
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

type SenseBus = CerebrumHandlerCtx["sense"];
type MotorBus = CerebrumHandlerCtx["motor"];

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

		const off = sense.subscribe("llm.phase", (event) => {
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

async function prepareTurn(
	payload: { messages?: readonly unknown[]; tools?: readonly ToolDef[]; text?: string },
	options: Pick<TurnLoopOptions, "getTools" | "prepareStep">,
): Promise<TurnSetup> {
	const rawMessages =
		payload.messages ?? (payload.text ? [{ role: "user", content: payload.text, timestamp: Date.now() }] : []);
	const nameMap = new Map<string, string>();
	const toolDefs = options.getTools?.() ?? payload.tools ?? [];
	const tools = buildTools(toolDefs as ToolDef[], nameMap);
	const rawMsgs = (rawMessages as Message[]).map(normalizeMessage);
	const messages = options.prepareStep ? await options.prepareStep(rawMsgs) : rawMsgs;
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

interface PendingCallClassification {
	replyCall: ToolCall | undefined;
	toolCalls: ToolCall[];
}

function classifyPendingCalls(pendingCalls: ToolCall[], toMotorName: (n: string) => string): PendingCallClassification {
	const replyCall = pendingCalls.find((tc) => toMotorName(tc.name) === DIALOG_MESSAGE);
	const toolCalls = pendingCalls.filter((tc) => toMotorName(tc.name) !== DIALOG_MESSAGE);
	return { replyCall, toolCalls };
}

function reportUsage(
	finalMessage: AssistantMessage,
	turn: number,
	agentIsReplying: boolean,
	options: Pick<TurnLoopOptions, "onTurnComplete" | "onEvent">,
): void {
	if (!finalMessage.usage) return;
	const usage: TokenUsage = {
		input: finalMessage.usage.input,
		output: finalMessage.usage.output,
		totalTokens: finalMessage.usage.totalTokens ?? finalMessage.usage.input + finalMessage.usage.output,
	};
	options.onTurnComplete?.(turn, usage);
	if (agentIsReplying) options.onEvent?.({ type: "token-usage", usage });
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

function publishReply(
	motor: MotorBus,
	correlationId: string,
	replyType: string,
	finalMessage: AssistantMessage,
	replyCall: ToolCall | undefined,
	messages: Message[],
	options: Pick<TurnLoopOptions, "onEvent">,
): void {
	const replyFromToolArgs = typeof replyCall?.args.text === "string" ? replyCall.args.text : undefined;
	const text = replyFromToolArgs ?? extractText(finalMessage);

	if (replyFromToolArgs) options.onEvent?.({ type: "chunk", text: replyFromToolArgs });

	if (text) {
		const conversationHistory = replyType === DIALOG_MESSAGE ? serializeConversationHistory(messages) : undefined;
		motor.publish({
			type: replyType,
			payload: { text, ...(conversationHistory ? { conversationHistory } : {}), usage: finalMessage.usage },
			correlationId,
		});
	} else {
		const fallback =
			finalMessage.errorMessage || (finalMessage.stopReason === "error" ? "An error occurred." : "(no response)");
		motor.publish({ type: replyType, payload: { text: fallback }, correlationId });
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
		type: "llm.phase",
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

export async function runLLMLoop(
	ctx: CerebrumHandlerCtx,
	options: TurnLoopOptions,
	onCheckpoint?: (messages: Message[], correlationId: string) => void,
): Promise<void> {
	const payload = ctx.payload as { messages?: readonly unknown[]; tools?: readonly ToolDef[]; text?: string };
	const { messages, tools, nameMap } = await prepareTurn(payload, options);
	const toMotorName = (llmName: string): string => nameMap.get(llmName) ?? llmName;

	const { correlationId, motor, sense } = ctx;
	const timeoutMs = options.timeoutMs ?? 60_000;
	const maxRetries = options.maxRetries ?? 4;
	const maxRetryDelayMs = options.maxRetryDelayMs ?? 8_000;
	const replyType = options.replyEvent ?? options.triggerEvent ?? DIALOG_MESSAGE;

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
					motor.publish({ type: replyType, payload: { text: phase.reply ?? "(skipped)" }, correlationId });
					break;
				}
				if (phase) applyPhaseResult(phase, messages, tools, nameMap);
			}

			const { finalMessage, pendingCalls } = await callLLM(
				model,
				messages,
				tools,
				turn,
				appRetryCount,
				effectiveOptions,
			);
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

			// Non-retryable LLM error — emit turn-error event and log at warn so
			// it's visible in production without --debug.
			if (finalMessage.stopReason === "error") {
				const errorMsg = finalMessage.errorMessage ?? "LLM returned an error response";
				effectiveOptions.onEvent?.({ type: "turn-error", message: errorMsg });
				debugLog("llm:turn:error", { turn, errorMessage: errorMsg });
			}

			messages.push(finalMessage);

			const { replyCall, toolCalls } = classifyPendingCalls(pendingCalls, toMotorName);
			const agentIsReplying = toolCalls.length === 0;

			motor.publish({
				type: "llm.result",
				payload: {
					response: { ...finalMessage } satisfies Record<string, unknown>,
					toolCalls: toolCalls.map((tc) => ({ name: toMotorName(tc.name), args: tc.args, id: tc.id })),
					turn,
				},
				correlationId,
			});

			reportUsage(finalMessage, turn, agentIsReplying, effectiveOptions);

			if (agentIsReplying) {
				publishReply(motor, correlationId, replyType, finalMessage, replyCall, messages, effectiveOptions);
				break;
			}

			const toolDefsMap = new Map((effectiveOptions.getTools?.() ?? []).map((t) => [t.name, t]));
			const results = await dispatchTools(motor, sense, correlationId, toolCalls, toMotorName, timeoutMs, {
				...effectiveOptions,
				toolDefs: toolDefsMap,
			});
			appendToolResults(messages, toolCalls, results, toMotorName);
			onCheckpoint?.(messages.slice(), ctx.correlationId);

			const steering = options.getSteeringMessages?.() ?? [];
			for (const msg of steering) messages.push(msg);
		}
	} finally {
		offBudget();
	}
}
