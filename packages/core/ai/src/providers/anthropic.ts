import Anthropic from "@anthropic-ai/sdk";
import type {
	CacheControlEphemeral,
	ContentBlockParam,
	MessageCreateParamsStreaming,
	MessageParam,
	RawMessageStreamEvent,
} from "@anthropic-ai/sdk/resources/messages.js";
import { getEnvApiKey } from "../env-api-keys.js";
import { calculateCost } from "../models/llm.js";
import type {
	AnthropicMessagesCompat,
	Api,
	AssistantMessage,
	CacheRetention,
	Context,
	ImageContent,
	Message,
	Model,
	SimpleStreamOptions,
	StopReason,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
	ToolResultMessage,
} from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { headersToRecord } from "../utils/headers.js";
import { parseJsonWithRepair, parseStreamingJson } from "../utils/json-parse.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";

import { resolveCloudflareBaseUrl } from "./cloudflare.js";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./github-copilot-headers.js";
import { adjustMaxTokensForThinking, buildBaseOptions } from "./base-options.js";
import { transformMessages } from "./normalize-messages.js";

/**
 * Resolve cache retention preference.
 * Defaults to "short" and uses ALEF_CACHE_RETENTION for backward compatibility.
 */
function resolveCacheRetention(cacheRetention?: CacheRetention): CacheRetention {
	if (cacheRetention) {
		return cacheRetention;
	}
	if (typeof process !== "undefined" && process.env.ALEF_CACHE_RETENTION === "long") {
		return "long";
	}
	return "short";
}

function getCacheControl(
	model: Model<"anthropic-messages">,
	cacheRetention?: CacheRetention,
): { retention: CacheRetention; cacheControl?: CacheControlEphemeral } {
	const retention = resolveCacheRetention(cacheRetention);
	if (retention === "none") {
		return { retention };
	}
	const ttl = retention === "long" && getAnthropicCompat(model).supportsLongCacheRetention ? "1h" : undefined;
	return {
		retention,
		cacheControl: { type: "ephemeral", ...(ttl && { ttl }) },
	};
}

import {
	CLAUDE_CODE_VERSION as claudeCodeVersion,
	fromClaudeCodeName,
	toClaudeCodeName,
} from "../utils/claude-code-names.js";

/**
 * Convert content blocks to Anthropic API format
 */
function convertContentBlocks(content: (TextContent | ImageContent)[]):
	| string
	| Array<
			| { type: "text"; text: string }
			| {
					type: "image";
					source: {
						type: "base64";
						media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
						data: string;
					};
			  }
	  > {
	// If only text blocks, return as concatenated string for simplicity
	const hasImages = content.some((c) => c.type === "image");
	if (!hasImages) {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- filtered to text-only content above
		return sanitizeSurrogates(content.map((c) => (c as TextContent).text).join("\n"));
	}

	// If we have images, convert to content block array
	const blocks = content.map((block) => {
		if (block.type === "text") {
			return {
				type: "text" as const,
				text: sanitizeSurrogates(block.text),
			};
		}
		return {
			type: "image" as const,
			source: {
				type: "base64" as const,
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- MIME type narrowing for API
				media_type: block.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
				data: block.data,
			},
		};
	});

	// If only images (no text), add placeholder text block
	const hasText = blocks.some((b) => b.type === "text");
	if (!hasText) {
		blocks.unshift({
			type: "text" as const,
			text: "(see attached image)",
		});
	}

	return blocks;
}

export type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";

export type AnthropicThinkingDisplay = "summarized" | "omitted";

const FINE_GRAINED_TOOL_STREAMING_BETA = "fine-grained-tool-streaming-2025-05-14";
const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14";

function getAnthropicCompat(model: Model<"anthropic-messages">): Required<AnthropicMessagesCompat> {
	return {
		supportsEagerToolInputStreaming: model.compat?.supportsEagerToolInputStreaming ?? true,
		supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? true,
	};
}

export interface AnthropicOptions extends StreamOptions {
	/**
	 * Enable extended thinking.
	 * For Opus 4.6 and Sonnet 4.6: uses adaptive thinking (model decides when/how much to think).
	 * For older models: uses budget-based thinking with thinkingBudgetTokens.
	 */
	thinkingEnabled?: boolean;
	/**
	 * Token budget for extended thinking (older models only).
	 * Ignored for Opus 4.6 and Sonnet 4.6, which use adaptive thinking.
	 */
	thinkingBudgetTokens?: number;
	/**
	 * Effort level for adaptive thinking (Opus 4.6+ and Sonnet 4.6).
	 * Controls how much thinking Claude allocates:
	 * - "max": Always thinks with no constraints (Opus 4.6 only)
	 * - "xhigh": Highest reasoning level (Opus 4.7)
	 * - "high": Always thinks, deep reasoning (default)
	 * - "medium": Moderate thinking, may skip for simple queries
	 * - "low": Minimal thinking, skips for simple tasks
	 * Ignored for older models.
	 */
	effort?: AnthropicEffort;
	/**
	 * Controls how thinking content is returned in API responses.
	 * - "summarized": Thinking blocks contain summarized thinking text (default here).
	 * - "omitted": Thinking blocks return an empty thinking field; the encrypted
	 *   signature still travels back for multi-turn continuity. Use for faster
	 *   time-to-first-text-token when your UI does not surface thinking.
	 *
	 * Note: Anthropic's API default for Claude Opus 4.7 and Claude Mythos Preview
	 * is "omitted". We default to "summarized" here to keep behavior consistent
	 * with older Claude 4 models. Set this explicitly to "omitted" to opt in.
	 */
	thinkingDisplay?: AnthropicThinkingDisplay;
	interleavedThinking?: boolean;
	toolChoice?: "auto" | "any" | "none" | { type: "tool"; name: string };
	/**
	 * Pre-built Anthropic client instance. When provided, skips internal client
	 * construction entirely. Use this to inject alternative SDK clients such as
	 * `AnthropicVertex` that shares the same messaging API.
	 */
	client?: Anthropic;
	/**
	 * Signal that the request is routed through Google Vertex AI.
	 * Enables Vertex-compatible tool name sanitization (dots → underscores).
	 * Set by the anthropic-vertex strategy; do not set directly.
	 */
	isVertex?: boolean;
}

function mergeHeaders(...headerSources: (Record<string, string | null> | undefined)[]): Record<string, string | null> {
	const merged: Record<string, string | null> = {};
	for (const headers of headerSources) {
		if (headers) {
			Object.assign(merged, headers);
		}
	}
	return merged;
}

interface ServerSentEvent {
	event: string | null;
	data: string;
	raw: string[];
}

interface SseDecoderState {
	event: string | null;
	data: string[];
	raw: string[];
}

const ANTHROPIC_MESSAGE_EVENTS: ReadonlySet<string> = new Set([
	"message_start",
	"message_delta",
	"message_stop",
	"content_block_start",
	"content_block_delta",
	"content_block_stop",
]);

/**
 * Serialize an error to a human-readable string, traversing the cause chain.
 * Gaxios/node-fetch errors store the root cause in `.error` (FetchError) or
 * `.cause`, and the syscall error code in `.code`. Without this traversal,
 * messages like "request to URL failed, reason: " appear with an empty reason.
 */
function serializeError(error: unknown): string {
	const parts: string[] = [];
	let current: unknown = error;
	const seen = new Set<unknown>();
	while (current != null && !seen.has(current)) {
		seen.add(current);
		if (current instanceof Error) {
			if (current.message) parts.push(current.message);
			// Append error code if not already in the message (e.g. ECONNREFUSED)
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Error subclass may carry .code
			const code = (current as { code?: string }).code;
			if (code && !current.message.includes(code)) parts.push(code);
			// gaxios FetchError stores the inner system error in `.error`
			const inner =
				(current as { error?: unknown; cause?: unknown }).error ?? (current as { cause?: unknown }).cause;
			current = inner;
		} else {
			parts.push(String(current));
			break;
		}
	}
	return parts.length > 0 ? parts.join(" — ") : JSON.stringify(error);
}

function flushSseEvent(state: SseDecoderState): ServerSentEvent | null {
	if (!state.event && state.data.length === 0) {
		return null;
	}

	const event: ServerSentEvent = {
		event: state.event,
		data: state.data.join("\n"),
		raw: [...state.raw],
	};
	state.event = null;
	state.data = [];
	state.raw = [];
	return event;
}

function decodeSseLine(line: string, state: SseDecoderState): ServerSentEvent | null {
	if (line === "") {
		return flushSseEvent(state);
	}

	state.raw.push(line);
	if (line.startsWith(":")) {
		return null;
	}

	const delimiterIndex = line.indexOf(":");
	const fieldName = delimiterIndex === -1 ? line : line.slice(0, delimiterIndex);
	let value = delimiterIndex === -1 ? "" : line.slice(delimiterIndex + 1);
	if (value.startsWith(" ")) {
		value = value.slice(1);
	}

	if (fieldName === "event") {
		state.event = value;
	} else if (fieldName === "data") {
		state.data.push(value);
	}

	return null;
}

function nextLineBreakIndex(text: string): number {
	const carriageReturnIndex = text.indexOf("\r");
	const newlineIndex = text.indexOf("\n");
	if (carriageReturnIndex === -1) {
		return newlineIndex;
	}
	if (newlineIndex === -1) {
		return carriageReturnIndex;
	}
	return Math.min(carriageReturnIndex, newlineIndex);
}

function consumeLine(text: string): { line: string; rest: string } | null {
	const lineBreakIndex = nextLineBreakIndex(text);
	if (lineBreakIndex === -1) {
		return null;
	}

	let nextIndex = lineBreakIndex + 1;
	if (text[lineBreakIndex] === "\r" && text[nextIndex] === "\n") {
		nextIndex += 1;
	}

	return {
		line: text.slice(0, lineBreakIndex),
		rest: text.slice(nextIndex),
	};
}

async function* iterateSseMessages(
	body: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
): AsyncGenerator<ServerSentEvent> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const state: SseDecoderState = { event: null, data: [], raw: [] };
	let buffer = "";

	try {
		// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- deliberate infinite loop, exits via break
		while (true) {
			if (signal?.aborted) {
				throw new Error("Request was aborted");
			}

			const { value, done } = await reader.read();
			if (done) {
				break;
			}

			buffer += decoder.decode(value, { stream: true });
			let consumed = consumeLine(buffer);
			while (consumed) {
				buffer = consumed.rest;
				const event = decodeSseLine(consumed.line, state);
				if (event) {
					yield event;
				}
				consumed = consumeLine(buffer);
			}
		}

		buffer += decoder.decode();
		let consumed = consumeLine(buffer);
		while (consumed) {
			buffer = consumed.rest;
			const event = decodeSseLine(consumed.line, state);
			if (event) {
				yield event;
			}
			consumed = consumeLine(buffer);
		}

		if (buffer.length > 0) {
			const event = decodeSseLine(buffer, state);
			if (event) {
				yield event;
			}
		}

		const trailingEvent = flushSseEvent(state);
		if (trailingEvent) {
			yield trailingEvent;
		}
	} finally {
		reader.releaseLock();
	}
}

async function* iterateAnthropicEvents(
	response: Response,
	signal?: AbortSignal,
): AsyncGenerator<RawMessageStreamEvent> {
	if (!response.body) {
		throw new Error("Attempted to iterate over an Anthropic response with no body");
	}

	let sawMessageStart = false;
	let sawMessageEnd = false;

	for await (const sse of iterateSseMessages(response.body, signal)) {
		if (sse.event === "error") {
			throw new Error(sse.data);
		}

		if (!ANTHROPIC_MESSAGE_EVENTS.has(sse.event ?? "")) {
			continue;
		}

		try {
			const event = parseJsonWithRepair<RawMessageStreamEvent>(sse.data);
			if (event.type === "message_start") {
				sawMessageStart = true;
			} else if (event.type === "message_stop") {
				sawMessageEnd = true;
			}
			yield event;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(
				`Could not parse Anthropic SSE event ${sse.event}: ${message}; data=${sse.data}; raw=${sse.raw.join("\\n")}`,
			);
		}
	}

	if (sawMessageStart && !sawMessageEnd) {
		throw new Error("Anthropic stream ended before message_stop");
	}
}

export const streamAnthropic: StreamFunction<"anthropic-messages", AnthropicOptions> = (
	model: Model<"anthropic-messages">,
	context: Context,
	options?: AnthropicOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api as Api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		try {
			let client: Anthropic;
			let isOAuth: boolean;
			// isVertex: driven by options.isVertex set by the anthropic-vertex strategy.
			// Env-var detection has moved to that strategy's match() predicate.
			const isVertex = options?.isVertex ?? false;

			if (options?.client) {
				client = options.client;
				isOAuth = false;
			} else if (isVertex) {
				// Vertex path — project/region resolved by the strategy before calling here.
				/* eslint-disable @typescript-eslint/prefer-nullish-coalescing -- empty string must fall through */
				const projectId =
					process.env.ANTHROPIC_VERTEX_PROJECT_ID?.trim() ||
					process.env.GOOGLE_CLOUD_PROJECT?.trim() ||
					process.env.GCLOUD_PROJECT?.trim() ||
					"";
				const region = process.env.CLOUD_ML_REGION?.trim() || process.env.GOOGLE_CLOUD_LOCATION?.trim() || "";
				/* eslint-enable @typescript-eslint/prefer-nullish-coalescing */
				// Node-only SDK; lazy-loaded so browser bundles skip it.
				const { AnthropicVertex } = await import("@anthropic-ai/vertex-sdk");
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- AnthropicVertex SDK type mismatch
				client = new AnthropicVertex({ projectId, region }) as unknown as Anthropic;
				isOAuth = false;
			} else {
				const apiKey = options?.apiKey ?? getEnvApiKey(model.provider) ?? "";

				let copilotDynamicHeaders: Record<string, string> | undefined;
				if (model.provider === "github-copilot") {
					const hasImages = hasCopilotVisionInput(context.messages);
					copilotDynamicHeaders = buildCopilotDynamicHeaders({
						messages: context.messages,
						hasImages,
					});
				}

				const created = createClient(
					model,
					apiKey,
					options?.interleavedThinking ?? true,
					shouldUseFineGrainedToolStreamingBeta(model, context),
					options?.headers,
					copilotDynamicHeaders,
				);
				client = created.client;
				isOAuth = created.isOAuthToken;
			}
			let params = buildParams(model, context, isOAuth, options, isVertex);
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== undefined) {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- onPayload callback boundary
				params = nextParams as MessageCreateParamsStreaming;
			}
			const requestOptions = {
				...(options?.signal ? { signal: options.signal } : {}),
				...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
				...(options?.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
			};
			const response = await client.messages.create({ ...params, stream: true }, requestOptions).asResponse();
			await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
			stream.push({ type: "start", partial: output });

			type Block = (ThinkingContent | TextContent | (ToolCall & { partialJson: string })) & { index: number };
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- internal streaming block type
			const blocks = output.content as Block[];

			// --- Content block start handlers (keyed by content_block.type) ---

			function handleTextBlockStart(event: Extract<RawMessageStreamEvent, { type: "content_block_start" }>) {
				const block: Block = {
					type: "text",
					text: "",
					index: event.index,
				};
				output.content.push(block);
				stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
			}

			function handleThinkingBlockStart(event: Extract<RawMessageStreamEvent, { type: "content_block_start" }>) {
				const block: Block = {
					type: "thinking",
					thinking: "",
					thinkingSignature: "",
					index: event.index,
				};
				output.content.push(block);
				stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
			}

			function handleRedactedThinkingBlockStart(
				event: Extract<RawMessageStreamEvent, { type: "content_block_start" }>,
			) {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- discriminant checked before dispatch
				const contentBlock = event.content_block as { type: "redacted_thinking"; data: string };
				const block: Block = {
					type: "thinking",
					thinking: "[Reasoning redacted]",
					thinkingSignature: contentBlock.data,
					redacted: true,
					index: event.index,
				};
				output.content.push(block);
				stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
			}

			function handleToolUseBlockStart(event: Extract<RawMessageStreamEvent, { type: "content_block_start" }>) {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- discriminant checked before dispatch
				const contentBlock = event.content_block as { type: "tool_use"; id: string; name: string; input: unknown };
				// Parse input if it's a JSON string (happens when eager streaming is disabled)
				let parsedInput: Record<string, any>;
				if (typeof contentBlock.input === "string") {
					try {
						parsedInput = JSON.parse(contentBlock.input);
					} catch {
						parsedInput = {};
					}
				} else {
					// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- API response boundary
					parsedInput = contentBlock.input as Record<string, any>;
				}

				const block: Block = {
					type: "toolCall",
					id: contentBlock.id,
					name: isOAuth
						? fromClaudeCodeName(contentBlock.name, context.tools)
						: isVertex
							? unsanitizeToolName(contentBlock.name, context.tools)
							: contentBlock.name,
					arguments: parsedInput,
					partialJson: "",
					index: event.index,
				};
				output.content.push(block);
				stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
			}

			const contentBlockStartHandlers: Record<
				string,
				(event: Extract<RawMessageStreamEvent, { type: "content_block_start" }>) => void
			> = {
				text: handleTextBlockStart,
				thinking: handleThinkingBlockStart,
				redacted_thinking: handleRedactedThinkingBlockStart,
				tool_use: handleToolUseBlockStart,
			};

			// --- Content block delta handlers (keyed by delta.type) ---

			function handleTextDelta(event: Extract<RawMessageStreamEvent, { type: "content_block_delta" }>) {
				const index = blocks.findIndex((b) => b.index === event.index);
				const block = blocks[index];
				// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- array index may be -1
				if (block && block.type === "text") {
					// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- discriminant checked before dispatch
					const delta = event.delta as { type: "text_delta"; text: string };
					block.text += delta.text;
					stream.push({
						type: "text_delta",
						contentIndex: index,
						delta: delta.text,
						partial: output,
					});
				}
			}

			function handleThinkingDelta(event: Extract<RawMessageStreamEvent, { type: "content_block_delta" }>) {
				const index = blocks.findIndex((b) => b.index === event.index);
				const block = blocks[index];
				// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- array index may be -1
				if (block && block.type === "thinking") {
					// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- discriminant checked before dispatch
					const delta = event.delta as { type: "thinking_delta"; thinking: string };
					block.thinking += delta.thinking;
					stream.push({
						type: "thinking_delta",
						contentIndex: index,
						delta: delta.thinking,
						partial: output,
					});
				}
			}

			function handleInputJsonDelta(event: Extract<RawMessageStreamEvent, { type: "content_block_delta" }>) {
				const index = blocks.findIndex((b) => b.index === event.index);
				const block = blocks[index];
				// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- array index may be -1
				if (block && block.type === "toolCall") {
					// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- discriminant checked before dispatch
					const delta = event.delta as { type: "input_json_delta"; partial_json: string };
					block.partialJson += delta.partial_json;
					block.arguments = parseStreamingJson(block.partialJson);
					stream.push({
						type: "toolcall_delta",
						contentIndex: index,
						delta: delta.partial_json,
						partial: output,
					});
				}
			}

			function handleSignatureDelta(event: Extract<RawMessageStreamEvent, { type: "content_block_delta" }>) {
				const index = blocks.findIndex((b) => b.index === event.index);
				const block = blocks[index];
				// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- array index may be -1
				if (block && block.type === "thinking") {
					// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- discriminant checked before dispatch
					const delta = event.delta as { type: "signature_delta"; signature: string };
					block.thinkingSignature = block.thinkingSignature ?? "";
					block.thinkingSignature += delta.signature;
				}
			}

			const contentBlockDeltaHandlers: Record<
				string,
				(event: Extract<RawMessageStreamEvent, { type: "content_block_delta" }>) => void
			> = {
				text_delta: handleTextDelta,
				thinking_delta: handleThinkingDelta,
				input_json_delta: handleInputJsonDelta,
				signature_delta: handleSignatureDelta,
			};

			// --- Top-level event handlers (keyed by event.type) ---

			function handleMessageStart(event: RawMessageStreamEvent) {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- discriminant checked before dispatch
				const e = event as Extract<RawMessageStreamEvent, { type: "message_start" }>;
				output.responseId = e.message.id;
				// Capture initial token usage from message_start event
				// This ensures we have input token counts even if the stream is aborted early
				output.usage.input = e.message.usage.input_tokens;
				output.usage.output = e.message.usage.output_tokens;
				output.usage.cacheRead = e.message.usage.cache_read_input_tokens ?? 0;
				output.usage.cacheWrite = e.message.usage.cache_creation_input_tokens ?? 0;
				// Anthropic doesn't provide total_tokens, compute from components
				output.usage.totalTokens =
					output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
				calculateCost(model, output.usage);
			}

			function handleContentBlockStart(event: RawMessageStreamEvent) {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- discriminant checked before dispatch
				const e = event as Extract<RawMessageStreamEvent, { type: "content_block_start" }>;
				// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- dispatch table may not cover future API types
				contentBlockStartHandlers[e.content_block.type]?.(e);
			}

			function handleContentBlockDelta(event: RawMessageStreamEvent) {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- discriminant checked before dispatch
				const e = event as Extract<RawMessageStreamEvent, { type: "content_block_delta" }>;
				// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- dispatch table may not cover future API types
				contentBlockDeltaHandlers[e.delta.type]?.(e);
			}

			function handleContentBlockStop(event: RawMessageStreamEvent) {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- discriminant checked before dispatch
				const e = event as Extract<RawMessageStreamEvent, { type: "content_block_stop" }>;
				const index = blocks.findIndex((b) => b.index === e.index);
				const block = blocks[index];
				// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- array index may be -1
				if (block) {
					delete (block as { index?: number }).index;
					if (block.type === "text") {
						stream.push({
							type: "text_end",
							contentIndex: index,
							content: block.text,
							partial: output,
						});
					} else if (block.type === "thinking") {
						stream.push({
							type: "thinking_end",
							contentIndex: index,
							content: block.thinking,
							partial: output,
						});
					} else {
						block.arguments = parseStreamingJson(block.partialJson);
						// Finalize in-place and strip the scratch buffer so replay only
						// carries parsed arguments.
						delete (block as { partialJson?: string }).partialJson;
						stream.push({
							type: "toolcall_end",
							contentIndex: index,
							toolCall: block,
							partial: output,
						});
					}
				}
			}

			function handleMessageDelta(event: RawMessageStreamEvent) {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- discriminant checked before dispatch
				const e = event as Extract<RawMessageStreamEvent, { type: "message_delta" }>;
				if (e.delta.stop_reason) {
					output.stopReason = mapStopReason(e.delta.stop_reason);
				}
				// Only update usage fields if present (not null).
				// Preserves input_tokens from message_start when proxies omit it in message_delta.
				if (e.usage.input_tokens != null) {
					output.usage.input = e.usage.input_tokens;
				}
				output.usage.output = e.usage.output_tokens;
				if (e.usage.cache_read_input_tokens != null) {
					output.usage.cacheRead = e.usage.cache_read_input_tokens;
				}
				if (e.usage.cache_creation_input_tokens != null) {
					output.usage.cacheWrite = e.usage.cache_creation_input_tokens;
				}
				// Anthropic doesn't provide total_tokens, compute from components
				output.usage.totalTokens =
					output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
				calculateCost(model, output.usage);
			}

			const eventHandlers: Record<string, (event: RawMessageStreamEvent) => void> = {
				message_start: handleMessageStart,
				content_block_start: handleContentBlockStart,
				content_block_delta: handleContentBlockDelta,
				content_block_stop: handleContentBlockStop,
				message_delta: handleMessageDelta,
			};

			for await (const event of iterateAnthropicEvents(response, options?.signal)) {
				// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- dispatch table may not cover future API event types
				eventHandlers[event.type]?.(event);
			}

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw new Error("An unknown error occurred");
			}

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- stripping internal streaming property
				delete (block as { index?: number }).index;
				// partialJson is only a streaming scratch buffer; never persist it.
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- stripping internal streaming property
				delete (block as { partialJson?: string }).partialJson;
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = serializeError(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

/**
 * Check if a model supports adaptive thinking (Opus 4.6+, Sonnet 4.6)
 */
function supportsAdaptiveThinking(modelId: string): boolean {
	// Adaptive-thinking model IDs (with or without date suffix)
	return (
		modelId.includes("opus-4-6") ||
		modelId.includes("opus-4.6") ||
		modelId.includes("opus-4-7") ||
		modelId.includes("opus-4.7") ||
		modelId.includes("sonnet-4-6") ||
		modelId.includes("sonnet-4.6")
	);
}

/**
 * Map ThinkingLevel to Anthropic effort levels for adaptive thinking.
 * Note: effort "max" is only valid on Opus 4.6, while Opus 4.7 supports "xhigh".
 */
function mapThinkingLevelToEffort(
	model: Model<"anthropic-messages">,
	level: SimpleStreamOptions["reasoning"],
): AnthropicEffort {
	const mapped = level ? model.thinkingLevelMap?.[level] : undefined;
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- type narrowing after typeof check
	if (typeof mapped === "string") return mapped as AnthropicEffort;

	switch (level) {
		case "minimal":
		case "low":
			return "low";
		case "medium":
			return "medium";
		case "high":
			return "high";
		default:
			return "high";
	}
}

export const streamSimpleAnthropic: StreamFunction<
	"anthropic-messages",
	SimpleStreamOptions & { isVertex?: boolean }
> = (
	model: Model<"anthropic-messages">,
	context: Context,
	options?: SimpleStreamOptions & { isVertex?: boolean },
): AssistantMessageEventStream => {
	const apiKey = options?.apiKey ?? getEnvApiKey(model.provider) ?? "";
	const isVertex = options?.isVertex ?? false;

	if (!apiKey && !isVertex) {
		throw new Error(`No API key for provider: ${model.provider}`);
	}

	const base = buildBaseOptions(model, options, apiKey);
	if (!options?.reasoning) {
		return streamAnthropic(model, context, { ...base, thinkingEnabled: false, isVertex } satisfies AnthropicOptions);
	}

	// For Opus 4.6 and Sonnet 4.6: use adaptive thinking with effort level
	// For older models: use budget-based thinking
	if (supportsAdaptiveThinking(model.id)) {
		const effort = mapThinkingLevelToEffort(model, options.reasoning);
		return streamAnthropic(model, context, {
			...base,
			thinkingEnabled: true,
			effort,
			isVertex,
		} satisfies AnthropicOptions);
	}

	const adjusted = adjustMaxTokensForThinking(
		base.maxTokens ?? 0,
		model.maxTokens,
		options.reasoning,
		options.thinkingBudgets,
	);

	return streamAnthropic(model, context, {
		...base,
		maxTokens: adjusted.maxTokens,
		thinkingEnabled: true,
		thinkingBudgetTokens: adjusted.thinkingBudget,
		isVertex,
	} satisfies AnthropicOptions);
};

function isOAuthToken(apiKey: string): boolean {
	return apiKey.includes("sk-ant-oat");
}

function createClient(
	model: Model<"anthropic-messages">,
	apiKey: string,
	interleavedThinking: boolean,
	useFineGrainedToolStreamingBeta: boolean,
	optionsHeaders?: Record<string, string>,
	dynamicHeaders?: Record<string, string>,
): { client: Anthropic; isOAuthToken: boolean } {
	// Adaptive thinking models (Opus 4.6, Sonnet 4.6) have interleaved thinking built-in.
	// The beta header is deprecated on Opus 4.6 and redundant on Sonnet 4.6, so skip it.
	const needsInterleavedBeta = interleavedThinking && !supportsAdaptiveThinking(model.id);
	const betaFeatures: string[] = [];
	if (useFineGrainedToolStreamingBeta) {
		betaFeatures.push(FINE_GRAINED_TOOL_STREAMING_BETA);
	}
	if (needsInterleavedBeta) {
		betaFeatures.push(INTERLEAVED_THINKING_BETA);
	}

	if (model.provider === "cloudflare-ai-gateway") {
		const client = new Anthropic({
			apiKey: null,
			authToken: null,
			baseURL: resolveCloudflareBaseUrl(model),
			dangerouslyAllowBrowser: true,
			defaultHeaders: mergeHeaders(
				{
					accept: "application/json",
					"anthropic-dangerous-direct-browser-access": "true",
					"cf-aig-authorization": `Bearer ${apiKey}`,
					"x-api-key": null,
					Authorization: null,
					...(betaFeatures.length > 0 ? { "anthropic-beta": betaFeatures.join(",") } : {}),
				},
				model.headers,
				optionsHeaders,
			),
		});

		return { client, isOAuthToken: false };
	}

	// Copilot: Bearer auth, selective betas.
	if (model.provider === "github-copilot") {
		const client = new Anthropic({
			apiKey: null,
			authToken: apiKey,
			baseURL: model.baseUrl,
			dangerouslyAllowBrowser: true,
			defaultHeaders: mergeHeaders(
				{
					accept: "application/json",
					"anthropic-dangerous-direct-browser-access": "true",
					...(betaFeatures.length > 0 ? { "anthropic-beta": betaFeatures.join(",") } : {}),
				},
				model.headers,
				dynamicHeaders,
				optionsHeaders,
			),
		});

		return { client, isOAuthToken: false };
	}

	// OAuth: Bearer auth, Claude Code identity headers
	if (isOAuthToken(apiKey)) {
		const client = new Anthropic({
			apiKey: null,
			authToken: apiKey,
			baseURL: model.baseUrl,
			dangerouslyAllowBrowser: true,
			defaultHeaders: mergeHeaders(
				{
					accept: "application/json",
					"anthropic-dangerous-direct-browser-access": "true",
					"anthropic-beta": ["claude-code-20250219", "oauth-2025-04-20", ...betaFeatures].join(","),
					"user-agent": `claude-cli/${claudeCodeVersion}`,
					"x-app": "cli",
				},
				model.headers,
				optionsHeaders,
			),
		});

		return { client, isOAuthToken: true };
	}

	// API key auth
	const client = new Anthropic({
		apiKey,
		baseURL: model.baseUrl,
		dangerouslyAllowBrowser: true,
		defaultHeaders: mergeHeaders(
			{
				accept: "application/json",
				"anthropic-dangerous-direct-browser-access": "true",
				...(betaFeatures.length > 0 ? { "anthropic-beta": betaFeatures.join(",") } : {}),
			},
			model.headers,
			optionsHeaders,
		),
	});

	return { client, isOAuthToken: false };
}

/** Vertex AI rejects tool names with dots; replace with underscores and reverse on receipt. */
function sanitizeToolName(name: string): string {
	return name.replace(/\./g, "_");
}

function unsanitizeToolName(name: string, tools: Tool[] | undefined): string {
	// Find the original tool name that sanitizes to this name.
	return tools?.find((t) => sanitizeToolName(t.name) === name)?.name ?? name;
}

function buildParams(
	model: Model<"anthropic-messages">,
	context: Context,
	isOAuthToken: boolean,
	options?: AnthropicOptions,
	isVertex = false,
): MessageCreateParamsStreaming {
	const { cacheControl } = getCacheControl(model, options?.cacheRetention);
	const params: MessageCreateParamsStreaming = {
		model: model.id,
		messages: convertMessages(context.messages, model, isOAuthToken, cacheControl),
		// eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- zero must fall through to default
		max_tokens: options?.maxTokens || (model.maxTokens / 3) | 0,
		stream: true,
	};

	// For OAuth tokens, we MUST include Claude Code identity
	if (isOAuthToken) {
		params.system = [
			{
				type: "text",
				text: "You are Claude Code, Anthropic's official CLI for Claude.",
				...(cacheControl ? { cache_control: cacheControl } : {}),
			},
		];
		if (context.systemPrompt) {
			params.system.push({
				type: "text",
				text: sanitizeSurrogates(context.systemPrompt),
				...(cacheControl ? { cache_control: cacheControl } : {}),
			});
		}
	} else if (context.systemPrompt) {
		// Add cache control to system prompt for non-OAuth tokens
		params.system = [
			{
				type: "text",
				text: sanitizeSurrogates(context.systemPrompt),
				...(cacheControl ? { cache_control: cacheControl } : {}),
			},
		];
	}

	// Temperature is incompatible with extended thinking (adaptive or budget-based).
	if (options?.temperature !== undefined && !options.thinkingEnabled) {
		params.temperature = options.temperature;
	}

	if (context.tools && context.tools.length > 0) {
		params.tools = convertTools(
			context.tools,
			isOAuthToken,
			getAnthropicCompat(model).supportsEagerToolInputStreaming,
			cacheControl,
			isVertex,
		);
	}

	// Configure thinking mode: adaptive (Opus 4.6+ and Sonnet 4.6),
	// budget-based (older models), or explicitly disabled.
	if (model.reasoning) {
		if (options?.thinkingEnabled) {
			// Default to "summarized" so Opus 4.7 and Mythos Preview behave like
			// older Claude 4 models (whose API default is also "summarized").
			const display: AnthropicThinkingDisplay = options.thinkingDisplay ?? "summarized";
			if (supportsAdaptiveThinking(model.id)) {
				// Adaptive thinking: Claude decides when and how much to think.
				params.thinking = { type: "adaptive", display };
				if (options.effort) {
					// The Anthropic SDK types can lag newly supported effort values such as "xhigh".
					params.output_config =
						options.effort === "xhigh"
							? // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- SDK type mismatch, xhigh not yet in SDK types
								({ effort: options.effort } as unknown as NonNullable<
									MessageCreateParamsStreaming["output_config"]
								>)
							: { effort: options.effort };
				}
			} else {
				// Budget-based thinking for older models
				params.thinking = {
					type: "enabled",
					// eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- zero must fall through to default
					budget_tokens: options.thinkingBudgetTokens || 1024,
					display,
				};
			}
		} else if (options?.thinkingEnabled === false) {
			params.thinking = { type: "disabled" };
		}
	}

	if (options?.metadata) {
		const userId = options.metadata.user_id;
		if (typeof userId === "string") {
			params.metadata = { user_id: userId };
		}
	}

	if (options?.toolChoice) {
		if (typeof options.toolChoice === "string") {
			params.tool_choice = { type: options.toolChoice };
		} else {
			params.tool_choice = options.toolChoice;
		}
	}

	return params;
}

// Normalize tool call IDs to match Anthropic's required pattern and length
function normalizeToolCallId(id: string): string {
	return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

function convertMessages(
	messages: Message[],
	model: Model<"anthropic-messages">,
	isOAuthToken: boolean,
	cacheControl?: CacheControlEphemeral,
): MessageParam[] {
	const params: MessageParam[] = [];

	// Transform messages for cross-provider compatibility
	const transformedMessages = transformMessages(messages, model, normalizeToolCallId);

	for (let i = 0; i < transformedMessages.length; i++) {
		const msg = transformedMessages[i];

		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				if (msg.content.trim().length > 0) {
					params.push({
						role: "user",
						content: sanitizeSurrogates(msg.content),
					});
				}
			} else {
				const blocks: ContentBlockParam[] = msg.content.map((item) => {
					if (item.type === "text") {
						return {
							type: "text",
							text: sanitizeSurrogates(item.text),
						};
					} else {
						return {
							type: "image",
							source: {
								type: "base64",
								// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- MIME type narrowing for API
								media_type: item.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
								data: item.data,
							},
						};
					}
				});
				const filteredBlocks = blocks.filter((b) => {
					if (b.type === "text") {
						return b.text.trim().length > 0;
					}
					return true;
				});
				if (filteredBlocks.length === 0) continue;
				params.push({
					role: "user",
					content: filteredBlocks,
				});
			}
		} else if (msg.role === "assistant") {
			const blocks: ContentBlockParam[] = [];

			for (const block of msg.content) {
				if (block.type === "text") {
					if (block.text.trim().length === 0) continue;
					blocks.push({
						type: "text",
						text: sanitizeSurrogates(block.text),
					});
				} else if (block.type === "thinking") {
					// Redacted thinking: pass the opaque payload back as redacted_thinking
					if (block.redacted) {
						blocks.push({
							type: "redacted_thinking",
							data: block.thinkingSignature!,
						});
						continue;
					}
					if (block.thinking.trim().length === 0) continue;
					// If thinking signature is missing/empty (e.g., from aborted stream),
					// convert to plain text block without <thinking> tags to avoid API rejection
					// and prevent Claude from mimicking the tags in responses
					if (!block.thinkingSignature || block.thinkingSignature.trim().length === 0) {
						blocks.push({
							type: "text",
							text: sanitizeSurrogates(block.thinking),
						});
					} else {
						blocks.push({
							type: "thinking",
							thinking: sanitizeSurrogates(block.thinking),
							signature: block.thinkingSignature,
						});
					}
				} else {
					blocks.push({
						type: "tool_use",
						id: block.id,
						name: isOAuthToken ? toClaudeCodeName(block.name) : block.name,
						input: block.arguments,
					});
				}
			}
			if (blocks.length === 0) continue;
			params.push({
				role: "assistant",
				content: blocks,
			});
		} else {
			// Collect all consecutive toolResult messages, needed for z.ai Anthropic endpoint
			const toolResults: ContentBlockParam[] = [];

			// Add the current tool result
			toolResults.push({
				type: "tool_result",
				tool_use_id: msg.toolCallId,
				content: convertContentBlocks(msg.content),
				is_error: msg.isError,
			});

			// Look ahead for consecutive toolResult messages
			let j = i + 1;
			while (j < transformedMessages.length && transformedMessages[j].role === "toolResult") {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- role checked in while condition
				const nextMsg = transformedMessages[j] as ToolResultMessage;
				toolResults.push({
					type: "tool_result",
					tool_use_id: nextMsg.toolCallId,
					content: convertContentBlocks(nextMsg.content),
					is_error: nextMsg.isError,
				});
				j++;
			}

			// Skip the messages we've already processed
			i = j - 1;

			// Add a single user message with all tool results
			params.push({
				role: "user",
				content: toolResults,
			});
		}
	}

	// Add cache_control to the last user message to cache conversation history
	if (cacheControl && params.length > 0) {
		const lastMessage = params[params.length - 1];
		if (lastMessage.role === "user") {
			if (Array.isArray(lastMessage.content)) {
				const lastBlock = lastMessage.content[lastMessage.content.length - 1];
				/* eslint-disable @typescript-eslint/no-unnecessary-condition -- array index may be out of bounds */
				if (
					lastBlock &&
					(lastBlock.type === "text" || lastBlock.type === "image" || lastBlock.type === "tool_result")
				) {
					/* eslint-enable @typescript-eslint/no-unnecessary-condition */
					// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Anthropic cache_control extension not in SDK types
					(lastBlock as any).cache_control = cacheControl;
				}
			} else if (typeof lastMessage.content === "string") {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Anthropic cache_control content type workaround
				lastMessage.content = [
					{
						type: "text",
						text: lastMessage.content,
						cache_control: cacheControl,
					},
				] as any;
			}
		}
	}

	return params;
}

function shouldUseFineGrainedToolStreamingBeta(model: Model<"anthropic-messages">, context: Context): boolean {
	return !!context.tools?.length && !getAnthropicCompat(model).supportsEagerToolInputStreaming;
}

function convertTools(
	tools: Tool[],
	isOAuthToken: boolean,
	supportsEagerToolInputStreaming: boolean,
	cacheControl?: CacheControlEphemeral,
	isVertex = false,
): Anthropic.Messages.Tool[] {
	return tools.map((tool, index) => {
		const schema = tool.parameters as { properties?: unknown; required?: string[] };

		return {
			name: isOAuthToken ? toClaudeCodeName(tool.name) : isVertex ? sanitizeToolName(tool.name) : tool.name,
			description: tool.description,
			...(supportsEagerToolInputStreaming ? { eager_input_streaming: true } : {}),
			input_schema: {
				type: "object",
				properties: schema.properties ?? {},
				required: schema.required ?? [],
			},
			...(cacheControl && index === tools.length - 1 ? { cache_control: cacheControl } : {}),
		};
	});
}

function mapStopReason(reason: Anthropic.Messages.StopReason | string): StopReason {
	switch (reason) {
		case "end_turn":
			return "stop";
		case "max_tokens":
			return "length";
		case "tool_use":
			return "toolUse";
		case "refusal":
			return "error";
		case "pause_turn": // Stop is good enough -> resubmit
			return "stop";
		case "stop_sequence":
			return "stop"; // We don't supply stop sequences, so this should never happen
		case "sensitive": // Content flagged by safety filters (not yet in SDK types)
			return "error";
		default:
			// Handle unknown stop reasons gracefully (API may add new values)
			throw new Error(`Unhandled stop reason: ${reason}`);
	}
}
