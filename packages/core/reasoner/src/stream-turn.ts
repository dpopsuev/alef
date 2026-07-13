const CHARS_PER_TOKEN = 4;
const ERROR_TRACE_MAX_LENGTH = 120;
const DEFAULT_MAX_RETRY_DELAY_MS = 8_000;
const DEFAULT_THINKING_TIMEOUT_MS = 300_000;
import type { Bus } from "@dpopsuev/alef-kernel/bus";
import { DEFAULT_LLM_TIMEOUT_MS } from "@dpopsuev/alef-kernel/execution";
import { traceEvent } from "@dpopsuev/alef-kernel/log";
import type { Api, AssistantMessage, Message, Model, ThinkingLevel, Tool } from "@dpopsuev/alef-ai/types";
import { streamSimple } from "@dpopsuev/alef-ai/stream";
import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";

const tracer = trace.getTracer("alef.adapter-llm");

/** A single tool invocation requested by the LLM — name, arguments, and correlation ID. */
export interface ToolCall {
	name: string;
	args: Record<string, unknown>;
	id: string;
}

/** Stream-time steering rule (TTSR-lite): abort + steer when accumulated text matches. */
export interface StreamRule {
	id: string;
	pattern: RegExp | string;
	on: "text" | "thinking" | "both";
	message: string;
}

/** Options for a single streaming LLM call — auth, timeout, thinking level, and bus handles. */
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
	streamRules?: readonly StreamRule[];
	onStreamRuleMatch?: (rule: StreamRule) => void;
}

/** Result of a single LLM streaming call — the final assistant message and any pending tool calls. */
export interface LLMCallResult {
	finalMessage: AssistantMessage | undefined;
	pendingCalls: ToolCall[];
	/** Set when a stream rule aborted the stream so the turn loop can inject steer. */
	abortedByStreamRule?: boolean;
}

/** Compile stream rules once per call. */
function compileStreamRules(rules: readonly StreamRule[]): Array<StreamRule & { regex: RegExp }> {
	return rules.map((rule) => ({
		...rule,
		regex: typeof rule.pattern === "string" ? new RegExp(rule.pattern) : rule.pattern,
	}));
}

/**
 * Accumulate stream deltas and fire the first matching rule.
 * Exported for unit tests with faux streams.
 */
export class StreamRuleWatcher {
	private textAccum = "";
	private thinkingAccum = "";
	private matched: (StreamRule & { regex: RegExp }) | undefined;
	private readonly rules: Array<StreamRule & { regex: RegExp }>;

	constructor(rules: readonly StreamRule[] = []) {
		this.rules = compileStreamRules(rules);
	}

	/** Push a delta; returns the matched rule once, then stays matched. */
	push(channel: "text" | "thinking", delta: string): StreamRule | undefined {
		if (this.matched || this.rules.length === 0) return this.matched;
		if (channel === "text") this.textAccum += delta;
		else this.thinkingAccum += delta;
		for (const rule of this.rules) {
			if (rule.on !== "both" && rule.on !== channel) continue;
			const target =
				rule.on === "both"
					? `${this.thinkingAccum}\n${this.textAccum}`
					: channel === "text"
						? this.textAccum
						: this.thinkingAccum;
			if (rule.regex.test(target)) {
				this.matched = rule;
				return rule;
			}
		}
		return undefined;
	}

	get matchedRule(): StreamRule | undefined {
		return this.matched;
	}
}

/** Stream a single LLM request, emitting chunk/thinking notifications and collecting tool calls. */
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

	const schemaTokenEstimate = Math.round(JSON.stringify(tools).length / CHARS_PER_TOKEN);

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
	const thinkingTimeoutMs = Number(process.env.ALEF_LLM_THINKING_TIMEOUT_MS) || DEFAULT_THINKING_TIMEOUT_MS;
	const timeoutMs = options.timeoutMs ?? (thinking ? thinkingTimeoutMs : defaultTimeoutMs);
	const maxRetryDelayMs = options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;

	const localAbort = new AbortController();
	const parentSignal = options.getSignal?.();
	if (parentSignal) {
		if (parentSignal.aborted) localAbort.abort();
		else parentSignal.addEventListener("abort", () => localAbort.abort(), { once: true });
	}

	const ruleWatcher = new StreamRuleWatcher(options.streamRules ?? []);

	const stream = streamSimple(
		model,
		{ messages: apiMessages, tools, ...(systemPrompt ? { systemPrompt } : {}) },
		{
			apiKey: options.getApiKey?.() ?? options.apiKey,
			timeoutMs,
			maxRetries: 2,
			maxRetryDelayMs,
			...(thinking ? { reasoning: thinking } : {}),
			signal: localAbort.signal,
		},
	);

	let finalMessage: AssistantMessage | undefined;
	const pendingCalls: ToolCall[] = [];
	const httpStart = Date.now();
	let abortedByStreamRule = false;

	try {
		for await (const event of stream) {
			switch (event.type) {
				case "text_delta": {
					options.notification.publish({
						type: "llm.chunk",
						payload: { text: event.delta },
						correlationId: options.correlationId,
					});
					const matched = ruleWatcher.push("text", event.delta);
					if (matched) {
						abortedByStreamRule = true;
						options.onStreamRuleMatch?.(matched);
						localAbort.abort();
					}
					break;
				}
				case "thinking_delta": {
					options.notification.publish({
						type: "llm.thinking",
						payload: { text: event.delta },
						correlationId: options.correlationId,
					});
					const matched = ruleWatcher.push("thinking", event.delta);
					if (matched) {
						abortedByStreamRule = true;
						options.onStreamRuleMatch?.(matched);
						localAbort.abort();
					}
					break;
				}
				case "toolcall_end":
					pendingCalls.push({
						name: event.toolCall.name,
						args: event.toolCall.arguments,
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
			if (abortedByStreamRule) break;
		}

		traceEvent("llm:http:done", {
			turn,
			elapsedMs: Date.now() - httpStart,
			stopReason: finalMessage?.stopReason ?? "none",
			abortedByStreamRule,
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
		if (abortedByStreamRule) span.setAttribute("alef.stream_rule_abort", true);
		span.setStatus({ code: SpanStatusCode.OK });
	} catch (err) {
		const isAbort =
			err instanceof Error &&
			(err.name === "AbortError" || err.message.includes("aborted") || err.message.includes("AbortError"));
		if (abortedByStreamRule || (isAbort && ruleWatcher.matchedRule)) {
			abortedByStreamRule = true;
			traceEvent("llm:http:stream-rule", {
				turn,
				ruleId: ruleWatcher.matchedRule?.id,
				elapsedMs: Date.now() - httpStart,
			});
			span.setAttribute("alef.stream_rule_abort", true);
			span.setStatus({ code: SpanStatusCode.OK });
			return { finalMessage, pendingCalls, abortedByStreamRule: true };
		}
		if (isAbort) span.setAttribute("alef.aborted", true);
		traceEvent("llm:http:error", {
			turn,
			elapsedMs: Date.now() - httpStart,
			abort: isAbort,
			err: String(err).slice(0, ERROR_TRACE_MAX_LENGTH),
		});
		if (retryCount > 0) span.setAttribute("alef.retry_count", retryCount);
		span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
		throw err;
	} finally {
		span.end();
	}

	return { finalMessage, pendingCalls, abortedByStreamRule: abortedByStreamRule || undefined };
}
