import type { Bus } from "@dpopsuev/alef-kernel/bus";
import { DEFAULT_LLM_TIMEOUT_MS } from "@dpopsuev/alef-kernel/execution";
import { traceEvent } from "@dpopsuev/alef-kernel/log";
import type { Api, AssistantMessage, Message, Model, ThinkingLevel, Tool } from "@dpopsuev/alef-ai/types";
import { streamSimple } from "@dpopsuev/alef-ai/stream";
import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";

const tracer = trace.getTracer("alef.adapter-llm");

export interface ToolCall {
	name: string;
	args: Record<string, unknown>;
	id: string;
}

export interface StreamTurnOptions {
	timeoutMs?: number;
	maxRetries?: number;
	maxRetryDelayMs?: number;
	thinking?: ThinkingLevel;
	getThinking?: () => ThinkingLevel | undefined;
	apiKey?: string;
	getApiKey?: () => string | undefined;
	systemPrompt?: string;
	getSignal?: () => AbortSignal | undefined;
	command: Bus["command"];
	notification: Bus["notification"];
	correlationId: string;
}

export interface LLMCallResult {
	finalMessage: AssistantMessage | undefined;
	pendingCalls: ToolCall[];
}

export async function callLLM(
	model: Model<Api>,
	messages: Message[],
	tools: Tool[],
	turn: number,
	retryCount: number,
	options: StreamTurnOptions,
): Promise<LLMCallResult> {
	// Extract system message injected by prepareStep (role:"system") and forward
	// it as context.systemPrompt — providers only read systemPrompt, not role:"system"
	// messages in the array, so the directives would be silently dropped otherwise.
	const systemMsg = messages.find((m) => (m as { role?: string }).role === "system");
	const apiMessages = systemMsg ? messages.filter((m) => (m as { role?: string }).role !== "system") : messages;
	const systemPrompt =
		typeof (systemMsg as { content?: unknown } | undefined)?.content === "string"
			? (systemMsg as { content: string }).content // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- narrowing validated system message
			: options.systemPrompt;

	const schemaTokenEstimate = Math.round(JSON.stringify(tools).length / 4);

	const span = tracer.startSpan(`chat ${model.id}`, {
		kind: SpanKind.CLIENT,
		attributes: {
			"gen_ai.operation.name": "chat",
			"gen_ai.request.model": model.id,
			"gen_ai.system": model.provider,
			"alef.schema_token_estimate": schemaTokenEstimate,
			"alef.turn_number": turn,
		},
	});
	span.addEvent("llm.call", {
		"alef.message_count": apiMessages.length,
		"alef.message_roles": apiMessages.map((m) => (m as { role?: string }).role ?? "?").join(","),
		"alef.tool_count": tools.length,
	});
	traceEvent("llm:http:start", {
		turn,
		messages: apiMessages.length,
		tools: tools.length,
		schemaEst: schemaTokenEstimate,
	});

	const thinking = options.getThinking?.() ?? options.thinking;
	const defaultTimeoutMs = DEFAULT_LLM_TIMEOUT_MS;
	const thinkingTimeoutMs = Number(process.env.ALEF_LLM_THINKING_TIMEOUT_MS) || 300_000;
	const timeoutMs = options.timeoutMs ?? (thinking ? thinkingTimeoutMs : defaultTimeoutMs);
	const maxRetryDelayMs = options.maxRetryDelayMs ?? 8_000;

	const stream = streamSimple(
		model,
		{ messages: apiMessages, tools, ...(systemPrompt ? { systemPrompt } : {}) },
		{
			apiKey: options.getApiKey?.() ?? options.apiKey,
			timeoutMs,
			maxRetries: 2,
			maxRetryDelayMs,
			...(thinking ? { reasoning: thinking } : {}),
			...(options.getSignal ? { signal: options.getSignal() } : {}),
		},
	);

	let finalMessage: AssistantMessage | undefined;
	const pendingCalls: ToolCall[] = [];
	const httpStart = Date.now();

	try {
		for await (const event of stream) {
			switch (event.type) {
				case "text_delta":
					options.notification.publish({
						type: "llm.chunk",
						payload: { text: event.delta },
						correlationId: options.correlationId,
					});
					break;
				case "thinking_delta":
					options.notification.publish({
						type: "llm.thinking",
						payload: { text: event.delta },
						correlationId: options.correlationId,
					});
					break;
				case "toolcall_end":
					pendingCalls.push({
						name: event.toolCall.name,
						args: event.toolCall.arguments as Record<string, unknown>,
						id: event.toolCall.id,
					});
					break;
				case "done":
					finalMessage = event.message;
					break;
				case "error":
					finalMessage = event.error;
					break;
			}
		}

		traceEvent("llm:http:done", {
			turn,
			elapsedMs: Date.now() - httpStart,
			stopReason: finalMessage?.stopReason ?? "none",
		});

		if (finalMessage?.usage) {
			const usage = finalMessage.usage;
			span.setAttributes({
				"gen_ai.usage.input_tokens": usage.input,
				"gen_ai.usage.output_tokens": usage.output,
				"gen_ai.usage.total_tokens": usage.totalTokens,
				"gen_ai.usage.cache_read_tokens": usage.cacheRead,
				"alef.estimated_cost_usd": usage.cost.total,
			});
		}
		if (retryCount > 0) span.setAttribute("alef.retry_count", retryCount);
		span.setStatus({ code: SpanStatusCode.OK });
	} catch (err) {
		const isAbort =
			err instanceof Error &&
			(err.name === "AbortError" || err.message.includes("aborted") || err.message.includes("AbortError"));
		if (isAbort) span.setAttribute("alef.aborted", true);
		traceEvent("llm:http:error", {
			turn,
			elapsedMs: Date.now() - httpStart,
			abort: isAbort,
			err: String(err).slice(0, 120),
		});
		if (retryCount > 0) span.setAttribute("alef.retry_count", retryCount);
		span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
		throw err;
	} finally {
		span.end();
	}

	return { finalMessage, pendingCalls };
}
