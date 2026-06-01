import {
	type Api,
	type AssistantMessage,
	type Message,
	type Model,
	streamSimple,
	type ThinkingLevel,
	type Tool,
} from "@dpopsuev/alef-ai";
import type { CerebrumHandlerCtx, Nerve, Organ, SenseEvent, ToolDefinition } from "@dpopsuev/alef-spine";
import { DIALOG_MESSAGE, defineOrgan, extractToolCallId, toolInputToJsonSchema } from "@dpopsuev/alef-spine";
import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { z } from "zod";
import type { TokenUsage, ToolCallEnd, ToolCallStart } from "./tool-events.js";

const tracer = trace.getTracer("alef.organ-llm");

export interface CerebrumOptions {
	model: Model<Api>;
	/**
	 * Called before each LLM call to obtain the current model.
	 * Takes precedence over model when set — enables live model switching
	 * via :model without restarting the agent (ALE-TSK-371).
	 */
	getModel?: () => Model<Api>;
	apiKey?: string;
	/**
	 * Called before each LLM call to obtain the current API key.
	 * Takes precedence over apiKey when both are set.
	 * Use this so a key saved by /login is picked up without restarting.
	 */
	getApiKey?: () => string | undefined;
	timeoutMs?: number;
	/** Max retry attempts on transient errors. Default: 4. */
	maxRetries?: number;
	/** Cap on retry delay in ms - prevents exponential backoff from stalling for minutes. Default: 8000. */
	maxRetryDelayMs?: number;
	/**
	 * Called each time the LLM loop retries a transient error (timeout, 429, overloaded).
	 * Use in eval pools to implement AIMD concurrency control: reduce pool size on retry,
	 * increase on consecutive successes. Does not affect retry behaviour.
	 */
	onRetry?: (attempt: number, reason: string) => void;
	/**
	 * Called at the start of each LLM call to obtain the current AbortSignal.
	 * The caller creates a new AbortController per turn and passes its signal here.
	 * When the controller is aborted (Ctrl+C mid-turn), the HTTP stream is cancelled.
	 */
	getSignal?: () => AbortSignal | undefined;
	onToolStart?: (event: ToolCallStart) => void;
	onToolEnd?: (event: ToolCallEnd) => void;
	onTokenUsage?: (usage: TokenUsage) => void;
	/**
	 * Called at the end of every LLM iteration (whether or not tool calls follow),
	 * passing the turn index and the usage for that call.
	 * Enables maxTurns and maxTokens enforcement in Budget middleware.
	 */
	onTurnComplete?: (turn: number, usage: TokenUsage) => void;
	/** Called with each streamed text delta as the LLM generates. */
	onResponseChunk?: (chunk: string) => void;
	/** Called with each streamed thinking/reasoning delta. */
	onThinkingChunk?: (chunk: string) => void;
	/**
	 * Extended thinking level. Requires a model that supports reasoning
	 * (e.g. claude-3-7-sonnet-20250219). Default: off (no thinking).
	 */
	thinking?: ThinkingLevel;
	/**
	 * Called before the turn loop with the full message array from the payload.
	 * Return a filtered/scored subset to use as the context window.
	 */
	prepareStep?: (messages: Message[]) => Message[] | Promise<Message[]>;
	/**
	 * Called after each completed tool round with the full accumulated messages
	 * and the turn's correlationId. Use to write a durable mid-turn checkpoint
	 * so context survives an abort that fires before the final dialog.message
	 * is published (ALE-TSK-368).
	 */
	onCheckpoint?: (messages: Message[], correlationId: string) => void;
	/**
	 * Track in-flight motor events from concurrent turns and inject a
	 * "Pending operations" context block before each LLM call.
	 * Only useful in HTTP/SSE mode where multiple turns run concurrently.
	 * Default: false — zero overhead in sequential interactive mode.
	 */
	trackConcurrentOps?: boolean;
	/**
	 * How long to wait (ms) for a sense/llm.phase response after publishing
	 * motor/llm.phase at the start of each reasoning iteration.
	 *
	 * Default: 0 — seam disabled, zero overhead. Set to a positive value when
	 * a phase organ is loaded (planning, enrichment, caching, etc.).
	 * If the timeout elapses with no response, the loop proceeds with the
	 * original messages unchanged.
	 */
	phaseTimeoutMs?: number;
	/**
	 * Sense event type that triggers a reasoning turn.
	 * Default: 'dialog.message' (conversation-driven agent).
	 * Set to any other event type for autonomous/reactive agents:
	 *   e.g. 'git.push', 'metric.alert', 'cron.tick'
	 * The Reasoner subscribes to sense/${triggerEvent}.
	 */
	triggerEvent?: string;
	/**
	 * Motor event type published as the final reply.
	 * Default: same as triggerEvent (mirrors the trigger channel).
	 * For conversation agents this is 'dialog.message'.
	 * For autonomous agents this can be any motor event type.
	 * conversationHistory is only included in the payload when
	 * triggerEvent === 'dialog.message'.
	 */
	replyEvent?: string;
}

// ---------------------------------------------------------------------------
// Core loop - pure function, receives ctx from framework
// ---------------------------------------------------------------------------

/**
 * Classify provider errors as retryable from the serialized error message.
 *
 * This is a compensating control for the loss of type information when
 * providers serialize errors to strings. Each case is documented to its source.
 *
 * TODO(alef-ai): add retryable?: boolean to the error stream event so
 * providers classify at the source with typed information, eliminating this.
 */
function isRetryableError(msg: string | undefined): boolean {
	if (!msg) return false;
	// Anthropic SDK APIConnectionTimeoutError.message = "Request timed out."
	// Also matches: "Connect Timeout Error", "Operation timed out"
	if (/timed[\s_]?out/i.test(msg)) return true;
	// Anthropic API 529: anthropic overloaded
	if (msg.includes("overloaded_error")) return true;
	// Network layer drops: "Network connection lost." (Anthropic)
	if (/network[\s_]connection[\s_]lost/i.test(msg)) return true;
	// TCP connect failure: "ConnectTimeoutError", "connection error"
	if (/connection[\s_]?(?:timed[\s_]?out|error)/i.test(msg)) return true;
	// HTTP 503
	if (/service[\s_]unavailable/i.test(msg)) return true;
	// HTTP 500
	if (/internal[\s_]server[\s_]error/i.test(msg)) return true;
	// HTTP 429 / Vertex RESOURCE_EXHAUSTED — rate limit, retry with backoff
	if (/429|rate[\s_]limit|too[\s_]many[\s_]requests|resource[\s_]exhausted|quota[\s_]exceeded/i.test(msg)) return true;
	return false;
}

/**
 * Normalise an incoming message to a valid Message.
 *
 * Handles two common mismatches between DialogOrgan's ConversationMessage
 * and the alef-ai Message type:
 *   1. Missing timestamp — injected so the LLM context assembler has ordering.
 *   2. assistant.content as plain string — Anthropic requires a content-block
 *      array; we promote "text" → [{type:"text", text}].
 */
function normalizeMessage(m: unknown): Message {
	const raw = m as Record<string, unknown>;
	// Inject timestamp if absent.
	const withTs: Record<string, unknown> = typeof raw.timestamp === "number" ? raw : { ...raw, timestamp: Date.now() };
	// Promote plain-string assistant content to block array.
	if (withTs.role === "assistant" && typeof withTs.content === "string") {
		return { ...withTs, content: [{ type: "text", text: withTs.content }] } as unknown as Message;
	}
	return withTs as unknown as Message;
}

async function runLLMLoop(
	ctx: CerebrumHandlerCtx,
	options: CerebrumOptions,
	onCheckpoint?: (messages: Message[], correlationId: string) => void,
): Promise<void> {
	const payload = ctx.payload as {
		messages?: readonly unknown[];
		tools?: readonly { name: string; description: string; inputSchema: z.ZodTypeAny }[];
		text?: string;
		sender?: string;
	};

	const rawMessages =
		payload.messages ?? (payload.text ? [{ role: "user", content: payload.text, timestamp: Date.now() }] : []);

	// Anthropic tool names must match ^[a-zA-Z0-9_-]{1,128}$.
	// Motor event types use dots (fs.read, shell.exec) - sanitize for the API
	// and keep a reverse map to recover the Motor event type from the LLM's response.
	const motorNameByLlmName = new Map<string, string>();
	const tools: Tool[] = (payload.tools ?? []).map((t) => {
		const llmName = t.name.replace(/\./g, "_");
		motorNameByLlmName.set(llmName, t.name);
		return { name: llmName, description: t.description, parameters: toolInputToJsonSchema(t.inputSchema) };
	});
	const toMotorName = (llmName: string): string => motorNameByLlmName.get(llmName) ?? llmName;

	const rawMsgs: Message[] = (rawMessages as Message[]).map((m) => normalizeMessage(m));

	const messages: Message[] = options.prepareStep ? await options.prepareStep(rawMsgs) : rawMsgs;

	const { correlationId, motor, sense } = ctx;
	const timeoutMs = options.timeoutMs ?? 60_000;
	const maxRetries = options.maxRetries ?? 4;
	const maxRetryDelayMs = options.maxRetryDelayMs ?? 8_000;

	// Application-level transient error patterns - returned as clean stopReason:"error"
	// messages by the provider (not HTTP errors). The SDK retries HTTP failures;
	// we retry these at the LLM loop level.

	let appRetryCount = 0;
	let turn = 0;

	while (true) {
		turn++;
		// Resolve current model at the start of each iteration so :model switches
		// take effect on the next send without restarting the agent (ALE-TSK-371).
		const model = options.getModel?.() ?? options.model;

		// motor/llm.phase seam: zero-or-one organ may intercept each iteration.
		// When phaseTimeoutMs is 0 (default), the seam is disabled — zero overhead.
		if (options.phaseTimeoutMs) {
			// Subscribe before publishing — event delivery may be synchronous.
			const phaseT0 = Date.now();
			process.stderr.write(`[organ-llm] turn=${turn} llm.phase ENTER\n`);
			const phasePromise = waitForPhaseResult(sense, correlationId, options.phaseTimeoutMs);
			motor.publish({
				type: "llm.phase",
				payload: { messages: messages as unknown[], turn, toolCount: tools.length },
				correlationId,
			});
			const phase = await phasePromise;
			process.stderr.write(
				`[organ-llm] turn=${turn} llm.phase EXIT in ${Date.now() - phaseT0}ms phase=${phase ? "modified" : "timeout/none"}\n`,
			);
			if (phase) {
				if (phase.abort) break;
				if (phase.skip) {
					motor.publish({
						type: DIALOG_MESSAGE,
						payload: { text: phase.reply ?? "(skipped)" },
						correlationId,
					});
					break;
				}
				if (phase.messages && phase.messages.length > 0) {
					messages.splice(0, messages.length, ...phase.messages);
				}
				if (phase.tools && phase.tools.length > 0) {
					const newTools: Tool[] = phase.tools.map((t) => {
						const llmName = t.name.replace(/\./g, "_");
						motorNameByLlmName.set(llmName, t.name);
						return {
							name: llmName,
							description: t.description,
							parameters: toolInputToJsonSchema(t.inputSchema),
						};
					});
					tools.splice(0, tools.length, ...newTools);
				}
			}
		}

		const span = tracer.startSpan(`chat ${model.id}`, {
			kind: SpanKind.CLIENT,
			attributes: {
				"gen_ai.operation.name": "chat",
				"gen_ai.request.model": model.id,
				"gen_ai.system": model.provider,
			},
		});

		// Estimate tokens consumed by tool schemas on this call (chars / 4).
		// Recorded as a span attribute so EvalHarness can compute schemaFraction.
		const schemaTokenEstimate = Math.round(JSON.stringify(tools).length / 4);
		span.setAttribute("alef.schema_token_estimate", schemaTokenEstimate);
		span.setAttribute("alef.turn_number", turn);

		// Orange: log API call entry so hangs are diagnosable without adding debug prints.
		span.addEvent("llm.call", {
			"alef.message_count": messages.length,
			"alef.message_roles": messages.map((m) => (m as { role?: string }).role ?? "?").join(","),
			"alef.tool_count": tools.length,
		});
		// Orange diagnostic: log before and after HTTP call so hang location is pinpointed.
		process.stderr.write(
			`[organ-llm] turn=${turn} msg=${messages.length} tools=${tools.length} schema_est=${schemaTokenEstimate} → HTTP START\n`,
		);
		const httpStart = Date.now();

		const stream = streamSimple(
			model,
			{ messages, tools },
			{
				apiKey: options.getApiKey?.() ?? options.apiKey,
				timeoutMs,
				maxRetries,
				maxRetryDelayMs,
				...(options.thinking ? { reasoning: options.thinking } : {}),
				...(options.getSignal ? { signal: options.getSignal() } : {}),
			},
		);

		let finalMessage: AssistantMessage | undefined;
		const pendingCalls: Array<{ name: string; args: Record<string, unknown>; id: string }> = [];

		try {
			for await (const evt of stream) {
				if (evt.type === "text_delta") {
					options.onResponseChunk?.(evt.delta);
				} else if (evt.type === "thinking_delta") {
					options.onThinkingChunk?.(evt.delta);
				} else if (evt.type === "toolcall_end") {
					pendingCalls.push({
						name: evt.toolCall.name,
						args: evt.toolCall.arguments as Record<string, unknown>,
						id: evt.toolCall.id,
					});
				} else if (evt.type === "done") {
					finalMessage = evt.message;
				} else if (evt.type === "error") {
					finalMessage = evt.error;
				}
			}
			// Orange diagnostic: log HTTP completion time.
			process.stderr.write(
				`[organ-llm] turn=${turn} HTTP DONE in ${Date.now() - httpStart}ms stopReason=${finalMessage?.stopReason ?? "none"}\n`,
			);
			if (finalMessage?.usage) {
				const u = finalMessage.usage;
				span.setAttributes({
					"gen_ai.usage.input_tokens": u.input,
					"gen_ai.usage.output_tokens": u.output,
					"gen_ai.usage.total_tokens": u.totalTokens,
					"gen_ai.usage.cache_read_tokens": u.cacheRead,
					"alef.estimated_cost_usd": u.cost.total,
				});
			}
			// ALE-BUG-39: stamp retry count on successful completion too (zero when no retries).
			if (appRetryCount > 0) span.setAttribute("alef.retry_count", appRetryCount);
			span.setStatus({ code: SpanStatusCode.OK });
		} catch (err) {
			// ALE-BUG-40: distinguish abort (timeout/signal) from model error.
			const isAbort =
				err instanceof Error &&
				(err.name === "AbortError" || err.message.includes("aborted") || err.message.includes("AbortError"));
			if (isAbort) span.setAttribute("alef.aborted", true);
			process.stderr.write(
				`[organ-llm] turn=${turn} HTTP ERROR in ${Date.now() - httpStart}ms abort=${isAbort} err=${String(err).slice(0, 120)}\n`,
			);
			if (appRetryCount > 0) span.setAttribute("alef.retry_count", appRetryCount);
			span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
			span.end();
			throw err;
		} finally {
			span.end();
		}

		if (!finalMessage) break;

		// Application-level retry: pop error message and retry with backoff.
		if (
			finalMessage.stopReason === "error" &&
			typeof finalMessage.errorMessage === "string" &&
			isRetryableError(finalMessage.errorMessage) &&
			appRetryCount < maxRetries
		) {
			appRetryCount++;
			options.onRetry?.(appRetryCount, finalMessage.errorMessage);
			// ALE-BUG-39: record retry in span so post-mortem can distinguish throttle from slow model.
			span.addEvent("llm.retry", { attempt: appRetryCount, reason: finalMessage.errorMessage });
			process.stderr.write(
				`[organ-llm] turn=${turn} RETRY attempt=${appRetryCount} reason=${finalMessage.errorMessage?.slice(0, 80) ?? "unknown"}\n`,
			);
			const delayMs = Math.min(1_000 * 2 ** (appRetryCount - 1), maxRetryDelayMs);
			await new Promise<void>((res) => setTimeout(res, delayMs));
			pendingCalls.length = 0;
			continue;
		}

		messages.push(finalMessage);

		const replyType = options.replyEvent ?? options.triggerEvent ?? DIALOG_MESSAGE;
		const replyCall = pendingCalls.find((tc) => toMotorName(tc.name) === DIALOG_MESSAGE);
		const toolCalls = pendingCalls.filter((tc) => toMotorName(tc.name) !== DIALOG_MESSAGE);

		// motor/llm.result: fire-and-forget post-LLM hook. Organs can observe every
		// LLM decision (response text + tool call list) before execution begins.
		motor.publish({
			type: "llm.result",
			payload: {
				response: { ...finalMessage } satisfies Record<string, unknown>,
				toolCalls: toolCalls.map((tc) => ({ name: toMotorName(tc.name), args: tc.args, id: tc.id })),
				turn,
			},
			correlationId,
		});

		if (finalMessage.usage) {
			const usage: TokenUsage = {
				input: finalMessage.usage.input,
				output: finalMessage.usage.output,
				totalTokens: finalMessage.usage.totalTokens ?? finalMessage.usage.input + finalMessage.usage.output,
			};
			options.onTurnComplete?.(turn, usage);
			if (toolCalls.length === 0) {
				options.onTokenUsage?.(usage);
			}
		}

		if (toolCalls.length === 0) {
			const replyBodyFromTool = typeof replyCall?.args.text === "string" ? replyCall.args.text : undefined;
			const text = replyBodyFromTool ?? extractText(finalMessage);
			// When the reply body arrived inside a dialog_message tool call, the content was NOT
			// streamed as text_delta events - onResponseChunk was never called for it. Forward
			// it now so the TUI renders the full reply, not just the pre-tool intro text.
			if (replyBodyFromTool) {
				options.onResponseChunk?.(replyBodyFromTool);
			}
			const isConversation = replyType === DIALOG_MESSAGE;
			if (text) {
				// conversationHistory only makes sense for conversation-driven agents.
				const conversationHistory = isConversation
					? messages
							.filter((m) => (m as { role?: string }).role !== "system")
							.map((m): unknown => {
								const msg = m as {
									role: string;
									content: unknown;
									toolCallId?: string;
									toolName?: string;
									isError?: boolean;
								};
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
							})
					: undefined;
				motor.publish({
					type: replyType,
					payload: { text, ...(conversationHistory ? { conversationHistory } : {}), usage: finalMessage.usage },
					correlationId,
				});
			} else {
				const fallback =
					finalMessage.errorMessage ||
					(finalMessage.stopReason === "error" ? "An error occurred." : "(no response)");
				motor.publish({
					type: replyType,
					payload: { text: fallback },
					correlationId,
				});
			}
			break;
		}

		const results = await Promise.all(
			toolCalls.map((tc) => {
				const motorType = toMotorName(tc.name);
				const startedAt = Date.now();
				options.onToolStart?.({ callId: tc.id, name: motorType, args: tc.args });
				motor.publish({
					type: motorType,
					payload: { ...tc.args, toolCallId: tc.id },
					correlationId,
				});
				return waitForToolResult(sense, motorType, tc.id, correlationId).then((r) => {
					const displayBlock = extractDisplay(r.payload);
					const result = payloadToText(r.payload, r.isError, r.errorMessage);
					options.onToolEnd?.({
						callId: tc.id,
						elapsedMs: Date.now() - startedAt,
						ok: !r.isError,
						result,
						display: displayBlock?.text,
						displayKind: displayBlock?.mimeType,
					});
					return r;
				});
			}),
		);

		for (let i = 0; i < toolCalls.length; i++) {
			const tc = toolCalls[i];
			const result = results[i];
			messages.push({
				role: "toolResult",
				toolCallId: tc.id,
				toolName: toMotorName(tc.name),
				content: [{ type: "text", text: payloadToText(result.payload, result.isError, result.errorMessage) }],
				isError: result.isError,
				timestamp: Date.now(),
			});
		}

		// Checkpoint: save the accumulated message array after every completed
		// tool round so the caller can publish it on abort/error (ALE-BUG-8).
		onCheckpoint?.(messages.slice(), ctx.correlationId);
	}
}

/**
 * Wait for sense/llm.phase responses matching correlationId.
 * Returns the merged result from all pipeline stages, or undefined when the
 * timeout elapses with no responses.
 *
 * ordered-pipeline: multiple organs may each publish sense/llm.phase for the
 * same correlationId (ToolShell injects schemas, MemoryOrgan enriches context).
 * A short quiescence window collects all responses after the first one arrives,
 * then merges them field-by-field (last non-undefined wins per field).
 */
interface PhaseResult {
	/** Transformed message context. Replaces current messages when present. */
	messages?: Message[];
	/**
	 * Replacement tool list for this turn. When present, the loop re-maps
	 * these ToolDefinitions into provider Tool objects before the HTTP call.
	 * Used by ToolShell to inject promoted schemas after prior tool calls.
	 */
	tools?: ToolDefinition[];
	/** Skip the LLM call. Publish reply as dialog.message and break the loop. */
	skip?: boolean;
	reply?: string;
	/** Abort the loop without publishing a reply. */
	abort?: boolean;
}

/** Quiescence window after the first phase response: collects additional pipeline stages. */
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
		const stage = stages[i];
		if (stage === undefined) continue;
		const v = pick(stage);
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

function waitForPhaseResult(
	sense: CerebrumHandlerCtx["sense"],
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

		const deadlineTimer = setTimeout(finish, timeoutMs);

		const off = sense.subscribe("llm.phase", (event) => {
			if (event.correlationId !== correlationId) return;
			collected.push(parsePhaseResult(event.payload));
			// After first response, open a short quiescence window to collect
			// additional pipeline stages (e.g. MemoryOrgan after ToolShell).
			if (quiescenceTimer !== undefined) clearTimeout(quiescenceTimer);
			quiescenceTimer = setTimeout(finish, PHASE_PIPELINE_QUIESCENCE_MS);
		});
	});
}

function waitForToolResult(
	sense: CerebrumHandlerCtx["sense"],
	toolName: string,
	toolCallId: string,
	correlationId: string,
): Promise<SenseEvent> {
	return new Promise((resolve) => {
		const off = sense.subscribe(toolName, (event) => {
			if (event.payload.toolCallId === toolCallId && event.correlationId === correlationId) {
				// Skip streaming intermediate events — isFinal:false means more chunks are coming.
				if (event.payload.isFinal === false) return;
				off();
				resolve(event);
			}
		});
	});
}

/** Extract the human-readable display text and kind from a sense payload's _display block, if present. */
function extractDisplay(payload: Record<string, unknown>): { text: string; mimeType?: string } | undefined {
	const d = payload._display;
	if (d !== null && typeof d === "object" && typeof (d as Record<string, unknown>).text === "string") {
		const block = d as { text: string; mimeType?: string };
		return { text: block.text, mimeType: block.mimeType };
	}
	return undefined;
}

export function payloadToText(payload: Record<string, unknown>, isError: boolean, errorMessage?: string): string {
	if (isError) return errorMessage ?? JSON.stringify(payload);
	// Strip the human-facing display block - it must not reach the LLM context.
	const { _display: _d, toolCallId: _id, isFinal: _f, ...llm } = payload;
	if (typeof llm.content === "string") return llm.content;
	if (typeof llm.text === "string") return llm.text;
	return JSON.stringify(llm);
}

function extractText(message: AssistantMessage): string {
	return message.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("");
}

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
				// published on abort/error, preventing conversation amnesia (ALE-BUG-8).
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
					throw err; // re-throw so OTel span is marked as error
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

export class Cerebrum {
	private readonly organ: Organ;
	private readonly options: CerebrumOptions;
	/** In-flight motor events from concurrent turns. Populated only when trackConcurrentOps=true. */
	private readonly inflight = new Map<string, InflightEntry>();

	readonly name = "llm";
	readonly description = "LLM reasoning loop: calls the language model, dispatches tool calls, collects replies.";
	readonly labels = ["llm", "reasoning", "ai"] as const;
	readonly tools = [] as const;
	get publishSchemas() {
		const reply = this.options.replyEvent ?? this.options.triggerEvent ?? DIALOG_MESSAGE;
		return {
			motor: {
				[reply]: z.object({
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
					toolCalls: z.array(
						z.object({ name: z.string(), args: z.record(z.string(), z.unknown()), id: z.string() }),
					),
					turn: z.number().int().positive(),
				}),
			},
		};
	}

	get subscriptions() {
		// When tracking concurrent ops, declare the wildcard subscriptions so
		// agent.validate() sees them and Port validation passes.
		const base = this.organ.subscriptions;
		if (!this.options.trackConcurrentOps) return base;
		return {
			motor: [...base.motor, "*"] as readonly string[],
			sense: [...base.sense, "*"] as readonly string[],
		};
	}

	constructor(options: CerebrumOptions) {
		this.options = options;
		const wrappedOptions: CerebrumOptions = options.trackConcurrentOps
			? {
					...options,
					prepareStep: async (msgs: Message[]) => {
						const afterUser = options.prepareStep ? await options.prepareStep(msgs) : msgs;
						return this.applyInflightContext(afterUser as { role: string; content: string }[]) as Message[];
					},
				}
			: options;
		this.organ = createCerebrum(wrappedOptions);
	}

	private applyInflightContext<T extends { role: string; content: string }>(messages: T[]): T[] {
		if (this.inflight.size === 0) return messages;
		const now = Date.now();
		const lines = [...this.inflight.values()].map((e) => {
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

	mount(nerve: Nerve): () => void {
		const offOrgan = this.organ.mount(nerve);
		if (!this.options.trackConcurrentOps) return offOrgan;

		// Wire wildcard subscriptions for concurrent-ops tracking.
		const inflightExcluded = makeInflightExcluded(
			this.options.replyEvent ?? this.options.triggerEvent ?? DIALOG_MESSAGE,
		);
		const offMotor = nerve.motor.subscribe("*", (event) => {
			if (inflightExcluded.has(event.type)) return;
			const toolCallId = extractToolCallId(event.payload);
			this.inflight.set(inflightKey(event.type, event.correlationId, toolCallId), {
				type: event.type,
				correlationId: event.correlationId,
				startedAt: event.timestamp,
				keyArg: pickKeyArg(event.payload),
			});
		});
		const offSense = nerve.sense.subscribe("*", (event) => {
			const toolCallId = extractToolCallId(event.payload);
			this.inflight.delete(inflightKey(event.type, event.correlationId, toolCallId));
		});

		return () => {
			offOrgan();
			offMotor();
			offSense();
			this.inflight.clear();
		};
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
