import OpenAI from "openai";
import type { ChatCompletionChunk } from "openai/resources/chat/completions.js";
import { getEnvApiKey } from "../../env-api-keys.js";
import { clampThinkingLevel } from "../../models/llm.js";
import type {
	AssistantMessage,
	CacheRetention,
	Context,
	Model,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	ToolCall,
} from "../../types.js";
import { AssistantMessageEventStream } from "../../utils/event-stream.js";
import { headersToRecord } from "../../utils/headers.js";
import { parseStreamingJson } from "../../utils/json-parse.js";
import { isCloudflareProvider, resolveCloudflareBaseUrl } from "../cloudflare.js";

import { buildBaseOptions } from "../base-options.js";

import type { ResolvedOpenAICompletionsCompat } from "./completions-compat.js";
import { getCompat } from "./completions-compat.js";
import {
	applyAnthropicCacheControl,
	convertMessages,
	convertTools,
	getCompatCacheControl,
	hasToolHistory,
	resolveCacheRetention,
} from "./completions-messages.js";
import { mapStopReason, parseChunkUsage } from "./completions-state.js";

export type { ResolvedOpenAICompletionsCompat } from "./completions-compat.js";

/**
 *
 */
export interface OpenAICompletionsOptions extends StreamOptions {
	toolChoice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
	reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
}

export const streamOpenAICompletions: StreamFunction<"openai-completions", OpenAICompletionsOptions> = (
	model: Model<"openai-completions">,
	context: Context,
	options?: OpenAICompletionsOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	void (async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
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
			// eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty API key must fall through
			const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
			const compat = getCompat(model);
			const cacheRetention = resolveCacheRetention(options?.cacheRetention);
			const cacheSessionId = cacheRetention === "none" ? undefined : options?.sessionId;
			const client = createClient(model, context, apiKey, options?.headers, cacheSessionId, compat);
			let params = buildParams(model, context, options, compat, cacheRetention);
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== undefined) {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- onPayload callback boundary
				params = nextParams as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;
			}
			const requestOptions = {
				...(options?.signal ? { signal: options.signal } : {}),
				...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
				...(options?.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
			};
			const { data: openaiStream, response } = await client.chat.completions
				.create(params, requestOptions)
				.withResponse();
			await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
			stream.push({ type: "start", partial: output });

			interface StreamingToolCallBlock extends ToolCall {
				partialArgs?: string;
				streamIndex?: number;
			}
			type StreamingBlock = TextContent | ThinkingContent | StreamingToolCallBlock;
			type StreamingToolCallDelta = NonNullable<ChatCompletionChunk.Choice.Delta["tool_calls"]>[number];

			let textBlock: TextContent | null = null;
			let thinkingBlock: ThinkingContent | null = null;
			const toolCallBlocksByIndex = new Map<number, StreamingToolCallBlock>();
			const toolCallBlocksById = new Map<string, StreamingToolCallBlock>();
			const blocks = output.content as StreamingBlock[];
			const getContentIndex = (block: StreamingBlock) => blocks.indexOf(block);
			const finishTextBlock = (block: TextContent, contentIndex: number) => {
				stream.push({
					type: "text_end",
					contentIndex,
					content: block.text,
					partial: output,
				});
			};
			const finishThinkingBlock = (block: ThinkingContent, contentIndex: number) => {
				stream.push({
					type: "thinking_end",
					contentIndex,
					content: block.thinking,
					partial: output,
				});
			};
			const finishToolCallBlock = (block: StreamingToolCallBlock, contentIndex: number) => {
				block.arguments = parseStreamingJson(block.partialArgs);
				// Finalize in-place and strip the scratch buffers so replay only
				// carries parsed arguments.
				delete block.partialArgs;
				delete block.streamIndex;
				stream.push({
					type: "toolcall_end",
					contentIndex,
					toolCall: block,
					partial: output,
				});
			};
			const blockFinishers: Record<string, (block: StreamingBlock, contentIndex: number) => void> = {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- dispatch narrows StreamingBlock to TextContent
				text: (block, ci) => finishTextBlock(block as TextContent, ci),
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- dispatch narrows StreamingBlock to ThinkingContent
				thinking: (block, ci) => finishThinkingBlock(block as ThinkingContent, ci),
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- dispatch narrows StreamingBlock to StreamingToolCallBlock
				toolCall: (block, ci) => finishToolCallBlock(block as StreamingToolCallBlock, ci),
			};
			const finishBlock = (block: StreamingBlock) => {
				const contentIndex = getContentIndex(block);
				if (contentIndex === -1) {
					return;
				}
				blockFinishers[block.type](block, contentIndex);
			};
			const ensureTextBlock = () => {
				if (!textBlock) {
					textBlock = { type: "text", text: "" };
					blocks.push(textBlock);
					stream.push({ type: "text_start", contentIndex: getContentIndex(textBlock), partial: output });
				}
				return textBlock;
			};
			const ensureThinkingBlock = (thinkingSignature: string) => {
				if (!thinkingBlock) {
					thinkingBlock = {
						type: "thinking",
						thinking: "",
						thinkingSignature,
					};
					blocks.push(thinkingBlock);
					stream.push({ type: "thinking_start", contentIndex: getContentIndex(thinkingBlock), partial: output });
				}
				return thinkingBlock;
			};
			const ensureToolCallBlock = (toolCall: StreamingToolCallDelta) => {
				const streamIndex = typeof toolCall.index === "number" ? toolCall.index : undefined;
				let block = streamIndex !== undefined ? toolCallBlocksByIndex.get(streamIndex) : undefined;
				if (!block && toolCall.id) {
					block = toolCallBlocksById.get(toolCall.id);
				}
				if (!block) {
					block = {
						type: "toolCall",
						id: toolCall.id ?? "",
						name: toolCall.function?.name ?? "",
						arguments: {},
						partialArgs: "",
						streamIndex,
					};
					if (streamIndex !== undefined) {
						toolCallBlocksByIndex.set(streamIndex, block);
					}
					if (toolCall.id) {
						toolCallBlocksById.set(toolCall.id, block);
					}
					blocks.push(block);
					stream.push({
						type: "toolcall_start",
						contentIndex: getContentIndex(block),
						partial: output,
					});
				}
				if (streamIndex !== undefined && block.streamIndex === undefined) {
					block.streamIndex = streamIndex;
					toolCallBlocksByIndex.set(streamIndex, block);
				}
				if (toolCall.id) {
					toolCallBlocksById.set(toolCall.id, block);
				}
				return block;
			};

			for await (const chunk of openaiStream) {
				// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive guard for non-standard providers
				if (!chunk || typeof chunk !== "object") continue;

				// OpenAI documents ChatCompletionChunk.id as the unique chat completion identifier,
				// and each chunk in a streamed completion carries the same id.
				output.responseId ??= chunk.id;
				if (typeof chunk.model === "string" && chunk.model.length > 0 && chunk.model !== model.id) {
					output.responseModel ??= chunk.model;
				}
				if (chunk.usage) {
					output.usage = parseChunkUsage(chunk.usage, model);
				}

				const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
				if (!choice) continue;

				// Fallback: some providers (e.g., Moonshot) return usage
				// in choice.usage instead of the standard chunk.usage
				// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-type-assertion
				if (!chunk.usage && (choice as any).usage) {
					// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-type-assertion
					output.usage = parseChunkUsage((choice as any).usage, model);
				}

				if (choice.finish_reason) {
					const finishReasonResult = mapStopReason(choice.finish_reason);
					output.stopReason = finishReasonResult.stopReason;
					if (finishReasonResult.errorMessage) {
						output.errorMessage = finishReasonResult.errorMessage;
					}
				}

				if (
					choice.delta.content !== null &&
					choice.delta.content !== undefined &&
					choice.delta.content.length > 0
				) {
					const block = ensureTextBlock();
					block.text += choice.delta.content;
					stream.push({
						type: "text_delta",
						contentIndex: getContentIndex(block),
						delta: choice.delta.content,
						partial: output,
					});
				}

				// Some endpoints return reasoning in reasoning_content (llama.cpp),
				// or reasoning (other openai compatible endpoints)
				// Use the first non-empty reasoning field to avoid duplication
				// (e.g., chutes.ai returns both reasoning_content and reasoning with same content)
				const reasoningFields = ["reasoning_content", "reasoning", "reasoning_text"];
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- accessing non-standard provider fields
				const deltaFields = choice.delta as Record<string, unknown>;
				let foundReasoningField: string | null = null;
				for (const field of reasoningFields) {
					const value = deltaFields[field];
					if (typeof value === "string" && value.length > 0) {
						foundReasoningField = field;
						break;
					}
				}

				if (foundReasoningField) {
					const delta = deltaFields[foundReasoningField];
					if (typeof delta === "string" && delta.length > 0) {
						const block = ensureThinkingBlock(foundReasoningField);
						block.thinking += delta;
						stream.push({
							type: "thinking_delta",
							contentIndex: getContentIndex(block),
							delta,
							partial: output,
						});
					}
				}

				if (choice.delta.tool_calls) {
					for (const toolCall of choice.delta.tool_calls) {
						const block = ensureToolCallBlock(toolCall);
						if (!block.id && toolCall.id) {
							block.id = toolCall.id;
							toolCallBlocksById.set(toolCall.id, block);
						}
						if (!block.name && toolCall.function?.name) {
							block.name = toolCall.function.name;
						}

						let delta = "";
						if (toolCall.function?.arguments) {
							delta = toolCall.function.arguments;
							block.partialArgs = (block.partialArgs ?? "") + toolCall.function.arguments;
							block.arguments = parseStreamingJson(block.partialArgs);
						}
						stream.push({
							type: "toolcall_delta",
							contentIndex: getContentIndex(block),
							delta,
							partial: output,
						});
					}
				}

				// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-type-assertion
				const reasoningDetails = (choice.delta as any).reasoning_details;
				if (reasoningDetails && Array.isArray(reasoningDetails)) {
					for (const detail of reasoningDetails) {
						// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
						if (detail.type === "reasoning.encrypted" && detail.id && detail.data) {
							// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowing union to ToolCall after type check
							const matchingToolCall = output.content.find(
								// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
								(b) => b.type === "toolCall" && b.id === detail.id,
							) as ToolCall | undefined;
							if (matchingToolCall) {
								matchingToolCall.thoughtSignature = JSON.stringify(detail);
							}
						}
					}
				}
			}

			for (const block of blocks) {
				finishBlock(block);
			}
			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "aborted") {
				throw new Error("Request was aborted");
			}
			if (output.stopReason === "error") {
				// eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty error message must fall through
				throw new Error(output.errorMessage || "Provider returned an error stop reason");
			}

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- stripping internal streaming property
				delete (block as { index?: number }).index;
				// Streaming scratch buffers are only used during parsing; never persist them.
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- stripping internal streaming property
				delete (block as { partialArgs?: string }).partialArgs;
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- stripping internal streaming property
				delete (block as { streamIndex?: number }).streamIndex;
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
			// Some providers via OpenRouter give additional information in this field.
			// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-type-assertion
			const rawMetadata = (error as any)?.error?.metadata?.raw;
			if (rawMetadata) output.errorMessage += `\n${rawMetadata}`;
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

export const streamSimpleOpenAICompletions: StreamFunction<"openai-completions", SimpleStreamOptions> = (
	model: Model<"openai-completions">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	// eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty API key must fall through
	const apiKey = options?.apiKey || getEnvApiKey(model.provider);
	if (!apiKey) {
		throw new Error(`No API key for provider: ${model.provider}`);
	}

	const base = buildBaseOptions(model, options, apiKey);
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;
	const toolChoice = (options as OpenAICompletionsOptions | undefined)?.toolChoice;

	return streamOpenAICompletions(model, context, {
		...base,
		reasoningEffort,
		toolChoice,
	} satisfies OpenAICompletionsOptions);
};

/**
 *
 */
function createClient(
	model: Model<"openai-completions">,
	_context: Context,
	apiKey?: string,
	optionsHeaders?: Record<string, string>,
	sessionId?: string,
	compat: ResolvedOpenAICompletionsCompat = getCompat(model),
) {
	if (!apiKey) {
		if (!process.env.OPENAI_API_KEY) {
			throw new Error(
				"OpenAI API key is required. Set OPENAI_API_KEY environment variable or pass it as an argument.",
			);
		}
		apiKey = process.env.OPENAI_API_KEY;
	}

	// GitHub Copilot dynamic headers are injected by the github-copilot-openai-completions
	// strategy before this function is called (via options.headers).
	const headers = { ...model.headers };

	if (sessionId && compat.sendSessionAffinityHeaders) {
		headers.session_id = sessionId;
		headers["x-client-request-id"] = sessionId;
		headers["x-session-affinity"] = sessionId;
	}

	// Merge options headers last so they can override defaults
	if (optionsHeaders) {
		Object.assign(headers, optionsHeaders);
	}

	const defaultHeaders =
		model.provider === "cloudflare-ai-gateway"
			? {
					...headers,
					// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime value may be undefined despite Record<string,string> index signature
					Authorization: headers.Authorization ?? null,
					"cf-aig-authorization": `Bearer ${apiKey}`,
				}
			: headers;

	return new OpenAI({
		apiKey,
		baseURL: isCloudflareProvider(model.provider) ? resolveCloudflareBaseUrl(model) : model.baseUrl,
		dangerouslyAllowBrowser: true,
		defaultHeaders,
	});
}

type ThinkingFormatHandler = (
	params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
	model: Model<"openai-completions">,
	options: OpenAICompletionsOptions | undefined,
	compat: ResolvedOpenAICompletionsCompat,
) => void;

/** Apply Z.ai thinking format — sets enable_thinking flag. */
function applyZaiThinking(params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming, _model: Model<"openai-completions">, options: OpenAICompletionsOptions | undefined) {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-type-assertion
	(params as any).enable_thinking = !!options?.reasoningEffort;
}

/** Apply Qwen thinking format — sets enable_thinking flag. */
function applyQwenThinking(params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming, _model: Model<"openai-completions">, options: OpenAICompletionsOptions | undefined) {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-type-assertion
	(params as any).enable_thinking = !!options?.reasoningEffort;
}

/** Apply Qwen chat-template thinking format — sets chat_template_kwargs with enable_thinking and preserve_thinking. */
function applyQwenChatTemplateThinking(params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming, _model: Model<"openai-completions">, options: OpenAICompletionsOptions | undefined) {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-type-assertion
	(params as any).chat_template_kwargs = {
		enable_thinking: !!options?.reasoningEffort,
		preserve_thinking: true,
	};
}

/** Apply DeepSeek thinking format — sets thinking object and optional reasoning_effort. */
function applyDeepseekThinking(params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming, model: Model<"openai-completions">, options: OpenAICompletionsOptions | undefined) {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-type-assertion
	(params as any).thinking = { type: options?.reasoningEffort ? "enabled" : "disabled" };
	if (options?.reasoningEffort) {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-type-assertion
		(params as any).reasoning_effort =
			model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
	}
}

/** Apply OpenRouter thinking format — sets nested reasoning object with effort level. */
function applyOpenrouterThinking(params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming, model: Model<"openai-completions">, options: OpenAICompletionsOptions | undefined) {
	// OpenRouter normalizes reasoning across providers via a nested reasoning object.
	const openRouterParams = params as typeof params & { reasoning?: { effort?: string } };
	if (options?.reasoningEffort) {
		openRouterParams.reasoning = {
			effort: model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort,
		};
	} else if (model.thinkingLevelMap?.off !== null) {
		openRouterParams.reasoning = { effort: model.thinkingLevelMap?.off ?? "none" };
	}
}

/** Apply Together thinking format — sets reasoning enabled flag and optional reasoning_effort. */
function applyTogetherThinking(params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming, model: Model<"openai-completions">, options: OpenAICompletionsOptions | undefined, compat: ResolvedOpenAICompletionsCompat) {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- provider-specific params extension
	const togetherParams = params as Omit<typeof params, "reasoning_effort"> & {
		reasoning?: { enabled: boolean };
		reasoning_effort?: string;
	};
	togetherParams.reasoning = { enabled: !!options?.reasoningEffort };
	if (options?.reasoningEffort && compat.supportsReasoningEffort) {
		togetherParams.reasoning_effort = model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
	}
}

/** Apply OpenAI-style thinking — sets reasoning_effort when supported, including off-value fallback. */
function applyOpenaiThinking(params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming, model: Model<"openai-completions">, options: OpenAICompletionsOptions | undefined, compat: ResolvedOpenAICompletionsCompat) {
	if (options?.reasoningEffort && compat.supportsReasoningEffort) {
		// OpenAI-style reasoning_effort
		// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-type-assertion
		(params as any).reasoning_effort = model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
	} else if (!options?.reasoningEffort && compat.supportsReasoningEffort) {
		const offValue = model.thinkingLevelMap?.off;
		if (typeof offValue === "string") {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-type-assertion
			(params as any).reasoning_effort = offValue;
		}
	}
}

const thinkingFormatHandlers: Record<string, ThinkingFormatHandler> = {
	zai: applyZaiThinking,
	qwen: applyQwenThinking,
	"qwen-chat-template": applyQwenChatTemplateThinking,
	deepseek: applyDeepseekThinking,
	openrouter: applyOpenrouterThinking,
	together: applyTogetherThinking,
	openai: applyOpenaiThinking,
};

/**
 *
 */
function buildParams(
	model: Model<"openai-completions">,
	context: Context,
	options?: OpenAICompletionsOptions,
	compat: ResolvedOpenAICompletionsCompat = getCompat(model),
	cacheRetention: CacheRetention = resolveCacheRetention(options?.cacheRetention),
) {
	const messages = convertMessages(model, context, compat);
	const cacheControl = getCompatCacheControl(compat, cacheRetention);

	const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
		model: model.id,
		messages,
		stream: true,
		prompt_cache_key:
			(model.baseUrl.includes("api.openai.com") && cacheRetention !== "none") ||
			(cacheRetention === "long" && compat.supportsLongCacheRetention)
				? options?.sessionId
				: undefined,
		prompt_cache_retention: cacheRetention === "long" && compat.supportsLongCacheRetention ? "24h" : undefined,
	};

	if (compat.supportsUsageInStreaming !== false) {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-type-assertion
		(params as any).stream_options = { include_usage: true };
	}

	if (compat.supportsStore) {
		params.store = false;
	}

	if (options?.maxTokens) {
		if (compat.maxTokensField === "max_tokens") {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-type-assertion
			(params as any).max_tokens = options.maxTokens;
		} else {
			params.max_completion_tokens = options.maxTokens;
		}
	}

	if (options?.temperature !== undefined) {
		params.temperature = options.temperature;
	}

	if (context.tools && context.tools.length > 0) {
		params.tools = convertTools(context.tools, compat);
		if (compat.zaiToolStream) {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-type-assertion
			(params as any).tool_stream = true;
		}
	} else if (hasToolHistory(context.messages)) {
		// Anthropic (via LiteLLM/proxy) requires tools param when conversation has tool_calls/tool_results
		params.tools = [];
	}

	if (cacheControl) {
		applyAnthropicCacheControl(messages, params.tools, cacheControl);
	}

	if (options?.toolChoice) {
		params.tool_choice = options.toolChoice;
	}

	if (model.reasoning) {
		thinkingFormatHandlers[compat.thinkingFormat](params, model, options, compat);
	}

	// OpenRouter provider routing preferences
	if (model.baseUrl.includes("openrouter.ai") && model.compat?.openRouterRouting) {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-type-assertion
		(params as any).provider = model.compat.openRouterRouting;
	}

	// Vercel AI Gateway provider routing preferences
	if (model.baseUrl.includes("ai-gateway.vercel.sh") && model.compat?.vercelGatewayRouting) {
		const routing = model.compat.vercelGatewayRouting;
		if (routing.only || routing.order) {
			const gatewayOptions: Record<string, string[]> = {};
			if (routing.only) gatewayOptions.only = routing.only;
			if (routing.order) gatewayOptions.order = routing.order;
			// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-type-assertion
			(params as any).providerOptions = { gateway: gatewayOptions };
		}
	}

	return params;
}
