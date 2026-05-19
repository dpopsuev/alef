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
import { defineOrgan, toolInputToJsonSchema } from "@dpopsuev/alef-spine";
import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { z } from "zod";

const tracer = trace.getTracer("alef.organ-llm");

const DIALOG_MESSAGE = "dialog.message";

export interface LLMOrganOptions {
	model: Model<Api>;
	apiKey?: string;
	timeoutMs?: number;
	maxRetries?: number;
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
	 * Until TurnAssembler is wired, leave undefined — all messages are used as-is.
	 *
	 * Replaces the deleted compact() function which bypassed the event bus
	 * and mutated only the local message copy without updating DialogOrgan.history.
	 */
	prepareStep?: (messages: Message[]) => Message[] | Promise<Message[]>;
}

// ---------------------------------------------------------------------------
// Core loop — pure function, receives ctx from framework
// ---------------------------------------------------------------------------

async function runLLMLoop(ctx: CerebrumHandlerCtx, options: LLMOrganOptions): Promise<void> {
	const payload = ctx.payload as {
		messages?: readonly unknown[];
		tools?: readonly { name: string; description: string; inputSchema: Record<string, unknown> }[];
		text?: string;
		sender?: string;
	};

	const rawMessages =
		payload.messages ?? (payload.text ? [{ role: "user", content: payload.text, timestamp: Date.now() }] : []);

	// Anthropic tool names must match ^[a-zA-Z0-9_-]{1,128}$.
	// Motor event types use dots (fs.read, shell.exec) — sanitize for the API
	// and keep a reverse map to recover the Motor event type from the LLM's response.
	const motorNameByLlmName = new Map<string, string>();
	const tools: Tool[] = (payload.tools ?? []).map((t) => {
		const llmName = t.name.replace(/\./g, "_");
		motorNameByLlmName.set(llmName, t.name);
		return { name: llmName, description: t.description, parameters: toolInputToJsonSchema(t.inputSchema) };
	});
	const toMotorName = (llmName: string): string => motorNameByLlmName.get(llmName) ?? llmName;

	const rawMsgs: Message[] = (rawMessages as Message[]).map((m) => {
		const base =
			"timestamp" in m && typeof (m as { timestamp?: unknown }).timestamp === "number"
				? (m as Message)
				: ({ ...(m as object), timestamp: Date.now() } as Message);
		// Normalize assistant messages: plain-string content → content-block array.
		// DialogOrgan stores replies as { role: "assistant", content: "text" } but
		// Anthropic requires content: [{ type: "text", text: "..." }].
		if (base.role === "assistant" && typeof (base as { content?: unknown }).content === "string") {
			const text = (base as unknown as { content: string }).content;
			return { ...base, content: [{ type: "text", text }] } as Message;
		}
		return base;
	});

	const messages: Message[] = options.prepareStep ? await options.prepareStep(rawMsgs) : rawMsgs;

	const { correlationId, motor, sense } = ctx;
	const timeoutMs = options.timeoutMs ?? 60_000;
	const maxRetries = options.maxRetries ?? 3;

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
				apiKey: options.apiKey,
				timeoutMs,
				maxRetries,
				...(options.thinking ? { reasoning: options.thinking } : {}),
			},
		);

		let finalMessage: AssistantMessage | undefined;
		const pendingCalls: Array<{ name: string; args: Record<string, unknown>; id: string }> = [];

		try {
			for await (const evt of stream) {
				if (evt.type === "toolcall_end") {
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
		messages.push(finalMessage);

		const replyCall = pendingCalls.find((tc) => toMotorName(tc.name) === DIALOG_MESSAGE);
		const toolCalls = pendingCalls.filter((tc) => toMotorName(tc.name) !== DIALOG_MESSAGE);

		if (toolCalls.length === 0) {
			const text =
				(typeof replyCall?.args.text === "string" ? replyCall.args.text : undefined) ?? extractText(finalMessage);
			if (text) {
				// Anthropic API hangs if internal fields (timestamp, usage, etc.) are replayed — strip to role+content only.
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
					payload: { text, conversationHistory },
					correlationId,
					timestamp: Date.now(),
				});
			}
			break;
		}

		const results = await Promise.all(
			toolCalls.map((tc) => {
				const motorType = toMotorName(tc.name);
				motor.publish({
					type: motorType,
					payload: { ...tc.args, toolCallId: tc.id },
					correlationId,
					timestamp: Date.now(),
				});
				return waitForToolResult(sense, motorType, tc.id, correlationId);
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

function payloadToText(payload: Record<string, unknown>, isError: boolean, errorMessage?: string): string {
	if (isError) return errorMessage ?? JSON.stringify(payload);
	if (typeof payload.content === "string") return payload.content;
	if (typeof payload.text === "string") return payload.text;
	const { toolCallId: _id, isFinal: _f, ...rest } = payload;
	return JSON.stringify(rest);
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
				try {
					await runLLMLoop(ctx, options);
				} catch (err) {
					// Orange: surface LLM errors so dialog.send() resolves rather than hanging.
					ctx.motor.publish({
						type: DIALOG_MESSAGE,
						payload: { text: `LLM error: ${String(err)}` },
						correlationId: ctx.correlationId,
						timestamp: Date.now(),
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
