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
import { DIALOG_MESSAGE, defineOrgan, toolInputToJsonSchema } from "@dpopsuev/alef-spine";
import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { z } from "zod";
import type { TokenUsage, ToolCallEnd, ToolCallStart } from "./tool-events.js";

const tracer = trace.getTracer("alef.organ-llm");

export interface LLMOrganOptions {
	model: Model<Api>;
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
	 * Called at the start of each LLM call to obtain the current AbortSignal.
	 * The caller creates a new AbortController per turn and passes its signal here.
	 * When the controller is aborted (Ctrl+C mid-turn), the HTTP stream is cancelled.
	 */
	getSignal?: () => AbortSignal | undefined;
	onToolStart?: (event: ToolCallStart) => void;
	onToolEnd?: (event: ToolCallEnd) => void;
	onTokenUsage?: (usage: TokenUsage) => void;
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
	 *
	 * This is the TurnAssembler integration point (ALE-SPC-15, ALE-TSK-179).
	 * Until TurnAssembler is wired, leave undefined - all messages are used as-is.
	 *
	 * Replaces the deleted compact() function which bypassed the event bus
	 * and mutated only the local message copy without updating DialogOrgan.history.
	 */
	prepareStep?: (messages: Message[]) => Message[] | Promise<Message[]>;
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
	return false;
}

async function runLLMLoop(
	ctx: CerebrumHandlerCtx,
	options: LLMOrganOptions,
	/** Called with a snapshot of messages after each tool round completes. */
	onCheckpoint?: (messages: Message[]) => void,
): Promise<void> {
	const payload = ctx.payload as {
		messages?: readonly unknown[];
		tools?: readonly { name: string; description: string; inputSchema: Record<string, unknown> }[];
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

	const rawMsgs: Message[] = (rawMessages as Message[]).map((m) => {
		const base: Message =
			"timestamp" in m && typeof (m as { timestamp?: unknown }).timestamp === "number"
				? m
				: ({ ...(m as object), timestamp: Date.now() } as unknown as Message);
		// Normalize assistant messages: plain-string content → content-block array.
		// DialogOrgan stores replies as { role: "assistant", content: "text" } but
		// Anthropic requires content: [{ type: "text", text: "..." }].
		if (base.role === "assistant" && typeof (base as { content?: unknown }).content === "string") {
			const text = (base as unknown as { content: string }).content;
			const normalized: Message = { ...base, content: [{ type: "text", text }] } as unknown as Message;
			return normalized;
		}
		return base;
	});

	const messages: Message[] = options.prepareStep ? await options.prepareStep(rawMsgs) : rawMsgs;

	const { correlationId, motor, sense } = ctx;
	const timeoutMs = options.timeoutMs ?? 60_000;
	const maxRetries = options.maxRetries ?? 4;
	const maxRetryDelayMs = options.maxRetryDelayMs ?? 8_000;

	// Application-level transient error patterns - returned as clean stopReason:"error"
	// messages by the provider (not HTTP errors). The SDK retries HTTP failures;
	// we retry these at the LLM loop level.

	let appRetryCount = 0;

	while (true) {
		const span = tracer.startSpan(`chat ${options.model.id}`, {
			kind: SpanKind.CLIENT,
			attributes: {
				"gen_ai.operation.name": "chat",
				"gen_ai.request.model": options.model.id,
				"gen_ai.system": options.model.provider,
			},
		});

		// Orange: log API call entry so hangs are diagnosable without adding debug prints.
		span.addEvent("llm.call", {
			"alef.message_count": messages.length,
			"alef.message_roles": messages.map((m) => (m as { role?: string }).role ?? "?").join(","),
			"alef.tool_count": tools.length,
		});

		const stream = streamSimple(
			options.model,
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
			span.setStatus({ code: SpanStatusCode.OK });
		} catch (err) {
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
			const delayMs = Math.min(1_000 * 2 ** (appRetryCount - 1), maxRetryDelayMs);
			await new Promise<void>((res) => setTimeout(res, delayMs));
			pendingCalls.length = 0;
			continue;
		}

		messages.push(finalMessage);

		const replyCall = pendingCalls.find((tc) => toMotorName(tc.name) === DIALOG_MESSAGE);
		const toolCalls = pendingCalls.filter((tc) => toMotorName(tc.name) !== DIALOG_MESSAGE);

		if (toolCalls.length === 0) {
			if (finalMessage.usage) {
				options.onTokenUsage?.({ input: finalMessage.usage.input, output: finalMessage.usage.output });
			}
			const replyBodyFromTool = typeof replyCall?.args.text === "string" ? replyCall.args.text : undefined;
			const text = replyBodyFromTool ?? extractText(finalMessage);
			// When the reply body arrived inside a dialog_message tool call, the content was NOT
			// streamed as text_delta events - onResponseChunk was never called for it. Forward
			// it now so the TUI renders the full reply, not just the pre-tool intro text.
			if (replyBodyFromTool) {
				options.onResponseChunk?.(replyBodyFromTool);
			}
			if (text) {
				// Anthropic API hangs if internal fields (timestamp, usage, etc.) are replayed - strip to role+content only.
				const conversationHistory = messages
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
					});
				motor.publish({
					type: DIALOG_MESSAGE,
					payload: { text, conversationHistory, usage: finalMessage.usage },
					correlationId,
				});
			} else {
				// LLM ended the turn with no text (e.g. after a tool batch or on error).
				// Publish a non-empty sentinel so dialog.send() resolves and the user
				// gets visible feedback instead of a silent empty screen.
				const fallback =
					finalMessage.errorMessage ||
					(finalMessage.stopReason === "error" ? "An error occurred." : "(no response)");
				motor.publish({
					type: DIALOG_MESSAGE,
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
		onCheckpoint?.(messages.slice() as Message[]);
	}
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

export function createLLMOrgan(options: LLMOrganOptions): Organ {
	return defineOrgan("llm", {
		[`sense/${DIALOG_MESSAGE}`]: {
			handle: async (ctx: CerebrumHandlerCtx) => {
				// Holds the last tool-round snapshot so partial history can be
				// published on abort/error, preventing conversation amnesia (ALE-BUG-8).
				let partialHistory: Message[] | undefined;
				try {
					await runLLMLoop(ctx, options, (snapshot) => {
						partialHistory = snapshot;
					});
				} catch (err) {
					// Orange: surface LLM errors so dialog.send() resolves rather than hanging.
					// Include partial history so the next turn retains tool context.
					const text = `LLM error: ${String(err)}`;
					ctx.motor.publish({
						type: DIALOG_MESSAGE,
						payload: { text, ...(partialHistory ? { conversationHistory: partialHistory } : {}) },
						correlationId: ctx.correlationId,
					});
					throw err; // re-throw so OTel span is marked as error
				}
			},
		},
	});
}

export class LLMOrgan {
	private readonly organ: Organ;
	readonly name = "llm";
	readonly description = "LLM reasoning loop: calls the language model, dispatches tool calls, collects replies.";
	readonly labels = ["llm", "reasoning", "ai"] as const;
	readonly tools = [] as const;
	readonly publishSchemas = {
		motor: {
			"dialog.message": z.object({
				text: z.string().min(1),
				conversationHistory: z.array(z.unknown()).optional(),
				usage: z.object({ totalTokens: z.number() }).passthrough().optional(),
			}),
		},
	} as const;
	get subscriptions() {
		return this.organ.subscriptions;
	}

	constructor(options: LLMOrganOptions) {
		this.organ = createLLMOrgan(options);
	}

	mount(nerve: Nerve): () => void {
		return this.organ.mount(nerve);
	}
}

export type { ToolDefinition };
export type { TokenUsage, ToolCallEnd, ToolCallStart } from "./tool-events.js";
