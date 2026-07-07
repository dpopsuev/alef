import {
	BedrockRuntimeClient,
	type BedrockRuntimeClientConfig,
	BedrockRuntimeServiceException,
	StopReason as BedrockStopReason,
	type Tool as BedrockTool,
	CachePointType,
	CacheTTL,
	type ContentBlock,
	type ContentBlockDeltaEvent,
	type ContentBlockStartEvent,
	type ContentBlockStopEvent,
	ConversationRole,
	ConverseStreamCommand,
	type ConverseStreamMetadataEvent,
	ImageFormat,
	type Message,
	type SystemContentBlock,
	type ToolChoice,
	type ToolConfiguration,
	ToolResultStatus,
} from "@aws-sdk/client-bedrock-runtime";
import type { DocumentType } from "@smithy/types";
import { calculateCost } from "../models/llm.js";
import type {
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	Api,
	AssistantMessage,
	CacheRetention,
	Context,
	Model,
	SimpleStreamOptions,
	StopReason,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingBudgets,
	ThinkingContent,
	ThinkingLevel,
	Tool,
	ToolCall,
	ToolResultMessage,
} from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { parseStreamingJson } from "../utils/json-parse.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import { adjustMaxTokensForThinking, buildBaseOptions, clampReasoning } from "./base-options.js";
import { transformMessages } from "./normalize-messages.js";

/**
 *
 */
export type BedrockThinkingDisplay = "summarized" | "omitted";

/**
 *
 */
export interface BedrockOptions extends StreamOptions {
	region?: string;
	profile?: string;
	toolChoice?: "auto" | "any" | "none" | { type: "tool"; name: string };
	/* See https://docs.aws.amazon.com/bedrock/latest/userguide/inference-reasoning.html for supported models. */
	reasoning?: ThinkingLevel;
	/* Custom token budgets per thinking level. Overrides default budgets. */
	thinkingBudgets?: ThinkingBudgets;
	/* Only supported by Claude 4.x models, see https://docs.aws.amazon.com/bedrock/latest/userguide/claude-messages-extended-thinking.html#claude-messages-extended-thinking-tool-use-interleaved */
	interleavedThinking?: boolean;
	/**
	 * Controls how Claude's thinking content is returned in responses.
	 * - "summarized": Thinking blocks contain summarized thinking text (default here).
	 * - "omitted": Thinking content is redacted but the signature still travels back
	 *   for multi-turn continuity, reducing time-to-first-text-token.
	 *
	 * Note: Anthropic's API default for Claude Opus 4.7 and Mythos Preview is
	 * "omitted". We default to "summarized" here to keep behavior consistent with
	 * older Claude 4 models. Only applies to Claude models on Bedrock.
	 */
	thinkingDisplay?: BedrockThinkingDisplay;
	/** Key-value pairs attached to the inference request for cost allocation tagging.
	 * Keys: max 64 chars, no `aws:` prefix. Values: max 256 chars. Max 50 pairs.
	 * Tags appear in AWS Cost Explorer split cost allocation data.
	 * @see https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ConverseStream.html */
	requestMetadata?: Record<string, string>;
	/** Bearer token for Bedrock API key authentication.
	 * When set, bypasses SigV4 signing and sends Authorization: Bearer <token> instead.
	 * Requires `bedrock:CallWithBearerToken` IAM permission on the token's identity.
	 * Set via AWS_BEARER_TOKEN_BEDROCK env var or pass directly.
	 * @see https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazonbedrock.html */
	bearerToken?: string;
}

type Block = (TextContent | ThinkingContent | ToolCall) & { index?: number; partialJson?: string };

export const streamBedrock: StreamFunction<"bedrock-converse-stream", BedrockOptions> = (
	model: Model<"bedrock-converse-stream">,
	context: Context,
	options: BedrockOptions = {},
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	void (async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "bedrock-converse-stream",
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

		const blocks = output.content as Block[];

		const config: BedrockRuntimeClientConfig = {
			profile: options.profile,
		};
		const configuredRegion = getConfiguredBedrockRegion(options);
		const hasConfiguredProfile = hasConfiguredBedrockProfile();
		const endpointRegion = getStandardBedrockEndpointRegion(model.baseUrl);
		const useExplicitEndpoint = shouldUseExplicitBedrockEndpoint(
			model.baseUrl,
			configuredRegion,
			hasConfiguredProfile,
		);

		// Only pin standard AWS Bedrock runtime endpoints when no region/profile is configured.
		// This preserves custom endpoints (VPC/proxy) from #3402 without forcing built-in
		// catalog defaults such as us-east-1 to override AWS_REGION/AWS_PROFILE.
		if (useExplicitEndpoint) {
			config.endpoint = model.baseUrl;
		}

		// Resolve bearer token for Bedrock API key auth.
		// eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty string must fall through (not a valid token)
		const bearerToken = options.bearerToken || process.env.AWS_BEARER_TOKEN_BEDROCK || undefined;
		const useBearerToken = bearerToken !== undefined && process.env.AWS_BEDROCK_SKIP_AUTH !== "1";

		// in Node.js/Bun environment only
		if (typeof process !== "undefined" && (process.versions.node || process.versions.bun)) {
			// Region resolution: explicit option > env vars > SDK default chain.
			// When AWS_PROFILE is set, we leave region undefined so the SDK can
			// resovle it from aws profile configs. Otherwise fall back to us-east-1.
			if (configuredRegion) {
				config.region = configuredRegion;
			} else if (endpointRegion && useExplicitEndpoint) {
				config.region = endpointRegion;
			} else if (!hasConfiguredProfile) {
				config.region = "us-east-1";
			}

			// Support proxies that don't need authentication
			if (process.env.AWS_BEDROCK_SKIP_AUTH === "1") {
				config.credentials = {
					accessKeyId: "dummy-access-key",
					secretAccessKey: "dummy-secret-key",
				};
			}

			if (
				process.env.HTTP_PROXY ||
				process.env.HTTPS_PROXY ||
				process.env.NO_PROXY ||
				process.env.http_proxy ||
				process.env.https_proxy ||
				process.env.no_proxy
			) {
				const nodeHttpHandler = await import("@smithy/node-http-handler");
				const proxyAgent = await import("proxy-agent");

				const agent = new proxyAgent.ProxyAgent();

				// Bedrock runtime uses NodeHttp2Handler by default since v3.798.0, which is based
				// on `http2` module and has no support for http agent.
				// Use NodeHttpHandler to support http agent.
				config.requestHandler = new nodeHttpHandler.NodeHttpHandler({
					httpAgent: agent,
					httpsAgent: agent,
				});
			} else if (process.env.AWS_BEDROCK_FORCE_HTTP1 === "1") {
				// Some custom endpoints require HTTP/1.1 instead of HTTP/2
				const nodeHttpHandler = await import("@smithy/node-http-handler");
				config.requestHandler = new nodeHttpHandler.NodeHttpHandler();
			}
		} else {
			// Non-Node environment (browser): fall back to us-east-1 since
			// there's no config file resolution available.
			config.region =
				// eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty string must fall through to "us-east-1"
				configuredRegion || (endpointRegion && useExplicitEndpoint ? endpointRegion : undefined) || "us-east-1";
		}

		if (useBearerToken) {
			config.token = { token: bearerToken };
			config.authSchemePreference = ["httpBearerAuth"];
		}

		try {
			const client = new BedrockRuntimeClient(config);
			const cacheRetention = resolveCacheRetention(options.cacheRetention);
			let commandInput = {
				modelId: model.id,
				messages: convertMessages(context, model, cacheRetention),
				system: buildSystemPrompt(context.systemPrompt, model, cacheRetention),
				inferenceConfig: {
					...(options.maxTokens !== undefined && { maxTokens: options.maxTokens }),
					...(options.temperature !== undefined && { temperature: options.temperature }),
				},
				toolConfig: convertToolConfig(context.tools, options.toolChoice),
				additionalModelRequestFields: buildAdditionalModelRequestFields(model, options),
				...(options.requestMetadata !== undefined && { requestMetadata: options.requestMetadata }),
			};
			const nextCommandInput = await options.onPayload?.(commandInput, model);
			if (nextCommandInput !== undefined) {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- API payload boundary
				commandInput = nextCommandInput as typeof commandInput;
			}
			const command = new ConverseStreamCommand(commandInput);

			const response = await client.send(command, { abortSignal: options.signal });
			if (response.$metadata.httpStatusCode !== undefined) {
				const responseHeaders: Record<string, string> = {};
				if (response.$metadata.requestId) {
					responseHeaders["x-amzn-requestid"] = response.$metadata.requestId;
				}
				await options.onResponse?.({ status: response.$metadata.httpStatusCode, headers: responseHeaders }, model);
			}

			/** Stream event dispatch table keyed by ConverseStreamOutput discriminant. */
			type StreamItem = NonNullable<typeof response.stream> extends AsyncIterable<infer T> ? T : never;
			const streamHandlers: Record<string, (item: StreamItem) => void> = {
				messageStart(ev) {
					if (ev.messageStart!.role !== ConversationRole.ASSISTANT) {
						throw new Error("Unexpected assistant message start but got user message start instead");
					}
					stream.push({ type: "start", partial: output });
				},
				contentBlockStart(ev) {
					handleContentBlockStart(ev.contentBlockStart!, blocks, output, stream);
				},
				contentBlockDelta(ev) {
					handleContentBlockDelta(ev.contentBlockDelta!, blocks, output, stream);
				},
				contentBlockStop(ev) {
					handleContentBlockStop(ev.contentBlockStop!, blocks, output, stream);
				},
				messageStop(ev) {
					output.stopReason = mapStopReason(ev.messageStop!.stopReason);
				},
				metadata(ev) {
					handleMetadata(ev.metadata!, model, output);
				},
				/* eslint-disable @typescript-eslint/only-throw-error -- SDK exceptions extend Error but the union with undefined confuses the lint */
				internalServerException(ev) {
					throw ev.internalServerException;
				},
				modelStreamErrorException(ev) {
					throw ev.modelStreamErrorException;
				},
				validationException(ev) {
					throw ev.validationException;
				},
				throttlingException(ev) {
					throw ev.throttlingException;
				},
				serviceUnavailableException(ev) {
					throw ev.serviceUnavailableException;
				},
				/* eslint-enable @typescript-eslint/only-throw-error */
			};
			const streamHandlerKeys = Object.keys(streamHandlers);

			for await (const item of response.stream!) {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- key is one of the known discriminant names
				const key = streamHandlerKeys.find((k) => item[k as keyof StreamItem]);
				if (key) {
					streamHandlers[key](item);
				}
			}

			if (options.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "error" || output.stopReason === "aborted") {
				throw new Error("An unknown error occurred");
			}

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				delete (block as Block).index;
				// partialJson is only a streaming scratch buffer; never persist it.
				delete (block as Block).partialJson;
			}
			output.stopReason = options.signal?.aborted ? "aborted" : "error";
			output.errorMessage = formatBedrockError(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

/**
 * Human-readable prefixes for Bedrock SDK exception names.
 * The downstream retry logic in agent-session matches patterns like
 * `server.?error` and `service.?unavailable`, so we preserve the legacy
 * prefix format rather than using the raw SDK exception name.
 */
const BEDROCK_ERROR_PREFIXES: Record<string, string> = {
	InternalServerException: "Internal server error",
	ModelStreamErrorException: "Model stream error",
	ValidationException: "Validation error",
	ThrottlingException: "Throttling error",
	ServiceUnavailableException: "Service unavailable",
};

/**
 * Format a Bedrock error with a human-readable prefix.
 * AWS SDK exceptions (both from `client.send()` and from stream event items)
 * extend BedrockRuntimeServiceException. We map the `.name` to a stable
 * human-readable prefix so downstream consumers (retry logic, context-overflow
 * detection) can distinguish error categories via simple string matching.
 */
function formatBedrockError(error: unknown): string {
	const message = error instanceof Error ? error.message : JSON.stringify(error);
	if (error instanceof BedrockRuntimeServiceException) {
		const prefix = BEDROCK_ERROR_PREFIXES[error.name] ?? error.name;
		return `${prefix}: ${message}`;
	}
	return message;
}

export const streamSimpleBedrock: StreamFunction<"bedrock-converse-stream", SimpleStreamOptions> = (
	model: Model<"bedrock-converse-stream">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const base = buildBaseOptions(model, options, undefined);
	if (!options?.reasoning) {
		return streamBedrock(model, context, { ...base, reasoning: undefined } satisfies BedrockOptions);
	}

	if (isAnthropicClaudeModel(model)) {
		if (supportsAdaptiveThinking(model.id, model.name)) {
			return streamBedrock(model, context, {
				...base,
				reasoning: options.reasoning,
				thinkingBudgets: options.thinkingBudgets,
			} satisfies BedrockOptions);
		}

		const adjusted = adjustMaxTokensForThinking(
			base.maxTokens ?? 0,
			model.maxTokens,
			options.reasoning,
			options.thinkingBudgets,
		);

		return streamBedrock(model, context, {
			...base,
			maxTokens: adjusted.maxTokens,
			reasoning: options.reasoning,
			thinkingBudgets: {
				...(options.thinkingBudgets ?? {}),
				[clampReasoning(options.reasoning)!]: adjusted.thinkingBudget,
			},
		} satisfies BedrockOptions);
	}

	return streamBedrock(model, context, {
		...base,
		reasoning: options.reasoning,
		thinkingBudgets: options.thinkingBudgets,
	} satisfies BedrockOptions);
};

/**
 *
 */
function handleContentBlockStart(
	event: ContentBlockStartEvent,
	blocks: Block[],
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
): void {
	const index = event.contentBlockIndex!;
	const start = event.start;

	if (start?.toolUse) {
		const block: Block = {
			type: "toolCall",
			id: start.toolUse.toolUseId ?? "",
			name: start.toolUse.name ?? "",
			arguments: {},
			partialJson: "",
			index,
		};
		output.content.push(block);
		stream.push({ type: "toolcall_start", contentIndex: blocks.length - 1, partial: output });
	}
}

/**
 *
 */
function handleContentBlockDelta(
	event: ContentBlockDeltaEvent,
	blocks: Block[],
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
): void {
	const contentBlockIndex = event.contentBlockIndex!;
	const delta = event.delta;
	let index = blocks.findIndex((b) => b.index === contentBlockIndex);
	let block = blocks[index];

	if (delta?.text !== undefined) {
		// handleContentBlockStart is not sent for text blocks — create one if missing.
		// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- noUncheckedIndexedAccess is off; block can be undefined at runtime
		if (!block) {
			const newBlock: Block = { type: "text", text: "", index: contentBlockIndex };
			output.content.push(newBlock);
			index = blocks.length - 1;
			block = blocks[index];
			stream.push({ type: "text_start", contentIndex: index, partial: output });
		}
		if (block.type === "text") {
			block.text += delta.text;
			stream.push({ type: "text_delta", contentIndex: index, delta: delta.text, partial: output });
		}
	} else if (delta?.toolUse && block.type === "toolCall") {
		block.partialJson = (block.partialJson ?? "") + (delta.toolUse.input ?? "");
		block.arguments = parseStreamingJson(block.partialJson);
		stream.push({ type: "toolcall_delta", contentIndex: index, delta: delta.toolUse.input ?? "", partial: output });
	} else if (delta?.reasoningContent) {
		handleReasoningDelta(delta.reasoningContent, contentBlockIndex, block, index, blocks, output, stream);
	}
}

/**
 *
 */
function handleReasoningDelta(
	reasoningContent: NonNullable<NonNullable<ContentBlockDeltaEvent["delta"]>["reasoningContent"]>,
	contentBlockIndex: number,
	block: Block | undefined,
	index: number,
	blocks: Block[],
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
): void {
	let thinkingBlock = block;
	let thinkingIndex = index;

	if (!thinkingBlock) {
		const newBlock: Block = { type: "thinking", thinking: "", thinkingSignature: "", index: contentBlockIndex };
		output.content.push(newBlock);
		thinkingIndex = blocks.length - 1;
		thinkingBlock = blocks[thinkingIndex];
		stream.push({ type: "thinking_start", contentIndex: thinkingIndex, partial: output });
	}

	if (thinkingBlock.type !== "thinking") return;

	if (reasoningContent.text) {
		thinkingBlock.thinking += reasoningContent.text;
		stream.push({
			type: "thinking_delta",
			contentIndex: thinkingIndex,
			delta: reasoningContent.text,
			partial: output,
		});
	}
	if (reasoningContent.signature) {
		thinkingBlock.thinkingSignature =
			(thinkingBlock.thinkingSignature ?? "") + reasoningContent.signature;
	}
}

/**
 *
 */
function handleMetadata(
	event: ConverseStreamMetadataEvent,
	model: Model<"bedrock-converse-stream">,
	output: AssistantMessage,
): void {
	if (!event.usage) return;

	output.usage.input = event.usage.inputTokens ?? 0;
	output.usage.output = event.usage.outputTokens ?? 0;
	output.usage.cacheRead = event.usage.cacheReadInputTokens ?? 0;
	output.usage.cacheWrite = event.usage.cacheWriteInputTokens ?? 0;
	output.usage.totalTokens = event.usage.totalTokens ?? output.usage.input + output.usage.output;
	calculateCost(model, output.usage);
}

/**
 *
 */
function handleContentBlockStop(
	event: ContentBlockStopEvent,
	blocks: Block[],
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
): void {
	const index = blocks.findIndex((b) => b.index === event.contentBlockIndex);
	const block = blocks[index];
	// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- noUncheckedIndexedAccess is off; block can be undefined at runtime
	if (!block) return;
	delete (block).index;

	switch (block.type) {
		case "text":
			stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: output });
			break;
		case "thinking":
			stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: output });
			break;
		case "toolCall":
			block.arguments = parseStreamingJson(block.partialJson);
			// Finalize in-place and strip the scratch buffer so replay only
			// carries parsed arguments.
			delete (block as Block).partialJson;
			stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: output });
			break;
	}
}

/**
 * Check if the model supports adaptive thinking (Opus 4.6+, Sonnet 4.6).
 * Checks both model ID and model name to support application inference profiles
 * whose ARNs don't contain the model name.
 */
function getModelMatchCandidates(modelId: string, modelName?: string): string[] {
	const values = modelName ? [modelId, modelName] : [modelId];
	return values.flatMap((value) => {
		const lower = value.toLowerCase();
		return [lower, lower.replace(/[\s_.:]+/g, "-")];
	});
}

/**
 *
 */
function supportsAdaptiveThinking(modelId: string, modelName?: string): boolean {
	const candidates = getModelMatchCandidates(modelId, modelName);
	return candidates.some((s) => s.includes("opus-4-6") || s.includes("opus-4-7") || s.includes("sonnet-4-6"));
}

/**
 *
 */
function supportsNativeXhighEffort(model: Model<"bedrock-converse-stream">): boolean {
	const candidates = getModelMatchCandidates(model.id, model.name);
	return candidates.some((s) => s.includes("opus-4-7"));
}

/**
 *
 */
function mapThinkingLevelToEffort(
	model: Model<"bedrock-converse-stream">,
	level: SimpleStreamOptions["reasoning"],
): "low" | "medium" | "high" | "xhigh" | "max" {
	if (level === "xhigh" && supportsNativeXhighEffort(model)) return "xhigh";

	const mapped = level ? model.thinkingLevelMap?.[level] : undefined;
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowing string from thinkingLevelMap
	if (typeof mapped === "string") return mapped as "low" | "medium" | "high" | "xhigh" | "max";

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

/**
 * Check if the model is an Anthropic Claude model on Bedrock.
 * Checks both model ID and model name to support application inference profiles
 * whose ARNs don't contain the model name.
 */
function isAnthropicClaudeModel(model: Model<"bedrock-converse-stream">): boolean {
	const id = model.id.toLowerCase();
	const name = model.name.toLowerCase();
	return (
		id.includes("anthropic.claude") ||
		id.includes("anthropic/claude") ||
		name.includes("anthropic.claude") ||
		name.includes("anthropic/claude") ||
		name.includes("claude")
	);
}

/**
 * Check if the model supports prompt caching.
 * Supported: Claude 3.5 Haiku, Claude 3.7 Sonnet, Claude 4.x models
 *
 * For base models and system-defined inference profiles the model ID / ARN
 * contains the model name, so we can decide locally.
 *
 * For application inference profiles (whose ARNs don't contain the model name),
 * also checks model.name which is user-controlled via models.json or registerProvider.
 * As a last resort, set AWS_BEDROCK_FORCE_CACHE=1 to enable cache points.
 * Amazon Nova models have automatic caching and don't need explicit cache points.
 */
function supportsPromptCaching(model: Model<"bedrock-converse-stream">): boolean {
	const candidates = getModelMatchCandidates(model.id, model.name);

	const hasClaudeRef = candidates.some((s) => s.includes("claude"));
	if (!hasClaudeRef) {
		// Application inference profiles don't contain the model name in the ARN.
		// Allow users to force cache points via environment variable.
		if (typeof process !== "undefined" && process.env.AWS_BEDROCK_FORCE_CACHE === "1") return true;
		return false;
	}
	// Claude 4.x models (opus-4, sonnet-4, haiku-4)
	if (candidates.some((s) => s.includes("-4-"))) return true;
	// Claude 3.7 Sonnet
	if (candidates.some((s) => s.includes("claude-3-7-sonnet"))) return true;
	// Claude 3.5 Haiku
	if (candidates.some((s) => s.includes("claude-3-5-haiku"))) return true;
	return false;
}

/**
 * Check if the model supports thinking signatures in reasoningContent.
 * Only Anthropic Claude models support the signature field.
 * Other models (OpenAI, Qwen, Minimax, Moonshot, etc.) reject it with:
 * "This model doesn't support the reasoningContent.reasoningText.signature field"
 *
 * Checks both model ID and model name to support application inference profiles.
 */
function supportsThinkingSignature(model: Model<"bedrock-converse-stream">): boolean {
	return isAnthropicClaudeModel(model);
}

/**
 *
 */
function buildSystemPrompt(
	systemPrompt: string | undefined,
	model: Model<"bedrock-converse-stream">,
	cacheRetention: CacheRetention,
): SystemContentBlock[] | undefined {
	if (!systemPrompt) return undefined;

	const blocks: SystemContentBlock[] = [{ text: sanitizeSurrogates(systemPrompt) }];

	// Add cache point for supported Claude models when caching is enabled
	if (cacheRetention !== "none" && supportsPromptCaching(model)) {
		blocks.push({
			cachePoint: { type: CachePointType.DEFAULT, ...(cacheRetention === "long" ? { ttl: CacheTTL.ONE_HOUR } : {}) },
		});
	}

	return blocks;
}

/**
 *
 */
function normalizeToolCallId(id: string): string {
	const sanitized = id.replace(/[^a-zA-Z0-9_-]/g, "_");
	// eslint-disable-next-line no-magic-numbers
	return sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized;
}

/**
 * Convert a thinking content item into the appropriate Bedrock ContentBlock.
 *
 * Only Anthropic models support the signature field in reasoningText.
 * For other models, we omit the signature to avoid errors like:
 * "This model doesn't support the reasoningContent.reasoningText.signature field"
 *
 * Signatures arrive after thinking deltas. If a partial or externally
 * persisted message lacks a signature, Bedrock rejects the replayed
 * reasoning block. Fall back to plain text, matching Anthropic.
 */
function convertThinkingToContentBlock(
	c: ThinkingContent,
	model: Model<"bedrock-converse-stream">,
): ContentBlock {
	const sanitizedText = sanitizeSurrogates(c.thinking);

	if (!supportsThinkingSignature(model)) {
		return { reasoningContent: { reasoningText: { text: sanitizedText } } };
	}

	if (!c.thinkingSignature || c.thinkingSignature.trim().length === 0) {
		return { text: sanitizedText };
	}

	return {
		reasoningContent: {
			reasoningText: {
				text: sanitizedText,
				signature: c.thinkingSignature,
			},
		},
	};
}

/**
 *
 */
function convertMessages(
	context: Context,
	model: Model<"bedrock-converse-stream">,
	cacheRetention: CacheRetention,
): Message[] {
	const result: Message[] = [];
	const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);

	for (let i = 0; i < transformedMessages.length; i++) {
		const m = transformedMessages[i];

		switch (m.role) {
			case "user":
				result.push({
					role: ConversationRole.USER,
					content:
						typeof m.content === "string"
							? [{ text: sanitizeSurrogates(m.content) }]
							: m.content.map((c) => {
									switch (c.type) {
										case "text":
											return { text: sanitizeSurrogates(c.text) };
										case "image":
											return { image: createImageBlock(c.mimeType, c.data) };
										default:
											throw new Error("Unknown user content type");
									}
								}),
				});
				break;
			case "assistant": {
				// Skip assistant messages with empty content (e.g., from aborted requests)
				// Bedrock rejects messages with empty content arrays
				if (m.content.length === 0) {
					continue;
				}
				const contentBlocks: ContentBlock[] = [];
				for (const c of m.content) {
					switch (c.type) {
						case "text":
							// Skip empty text blocks
							if (c.text.trim().length === 0) continue;
							contentBlocks.push({ text: sanitizeSurrogates(c.text) });
							break;
						case "toolCall":
							contentBlocks.push({
								// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- JSON schema boundary cast
								toolUse: { toolUseId: c.id, name: c.name, input: c.arguments as unknown as DocumentType },
							});
							break;
						case "thinking":
							// Skip empty thinking blocks
							if (c.thinking.trim().length === 0) continue;
							contentBlocks.push(convertThinkingToContentBlock(c, model));
							break;
						default:
							throw new Error("Unknown assistant content type");
					}
				}
				// Skip if all content blocks were filtered out
				if (contentBlocks.length === 0) {
					continue;
				}
				result.push({
					role: ConversationRole.ASSISTANT,
					content: contentBlocks,
				});
				break;
			}
			case "toolResult": {
				// Collect all consecutive toolResult messages into a single user message
				// Bedrock requires all tool results to be in one message
				const toolResults: ContentBlock.ToolResultMember[] = [];

				// Add current tool result with all content blocks combined
				toolResults.push({
					toolResult: {
						toolUseId: m.toolCallId,
						content: m.content.map((c) =>
							c.type === "image"
								? { image: createImageBlock(c.mimeType, c.data) }
								: { text: sanitizeSurrogates(c.text) },
						),
						status: m.isError ? ToolResultStatus.ERROR : ToolResultStatus.SUCCESS,
					},
				});

				// Look ahead for consecutive toolResult messages
				let j = i + 1;
				while (j < transformedMessages.length && transformedMessages[j].role === "toolResult") {
					// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- role === "toolResult" guard above
				const nextMsg = transformedMessages[j] as ToolResultMessage;
					toolResults.push({
						toolResult: {
							toolUseId: nextMsg.toolCallId,
							content: nextMsg.content.map((c) =>
								c.type === "image"
									? { image: createImageBlock(c.mimeType, c.data) }
									: { text: sanitizeSurrogates(c.text) },
							),
							status: nextMsg.isError ? ToolResultStatus.ERROR : ToolResultStatus.SUCCESS,
						},
					});
					j++;
				}

				// Skip the messages we've already processed
				i = j - 1;

				result.push({
					role: ConversationRole.USER,
					content: toolResults,
				});
				break;
			}
			default:
				throw new Error("Unknown message role");
		}
	}

	// Add cache point to the last user message for supported Claude models when caching is enabled
	if (cacheRetention !== "none" && supportsPromptCaching(model) && result.length > 0) {
		const lastMessage = result[result.length - 1];
		if (lastMessage.role === ConversationRole.USER && lastMessage.content) {
			(lastMessage.content).push({
				cachePoint: {
					type: CachePointType.DEFAULT,
					...(cacheRetention === "long" ? { ttl: CacheTTL.ONE_HOUR } : {}),
				},
			});
		}
	}

	return result;
}

/**
 *
 */
function convertToolConfig(
	tools: Tool[] | undefined,
	toolChoice: BedrockOptions["toolChoice"],
): ToolConfiguration | undefined {
	if (!tools?.length || toolChoice === "none") return undefined;

	const bedrockTools: BedrockTool[] = tools.map((tool) => ({
		toolSpec: {
			name: tool.name,
			description: tool.description,
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- JSON schema boundary cast
			inputSchema: { json: tool.parameters as unknown as DocumentType },
		},
	}));

	let bedrockToolChoice: ToolChoice | undefined;
	switch (toolChoice) {
		case "auto":
			bedrockToolChoice = { auto: {} };
			break;
		case "any":
			bedrockToolChoice = { any: {} };
			break;
		default:
			if (toolChoice?.type === "tool") {
				bedrockToolChoice = { tool: { name: toolChoice.name } };
			}
	}

	return { tools: bedrockTools, toolChoice: bedrockToolChoice };
}

/**
 *
 */
function mapStopReason(reason: string | undefined): StopReason {
	switch (reason) {
		case BedrockStopReason.END_TURN:
		case BedrockStopReason.STOP_SEQUENCE:
			return "stop";
		case BedrockStopReason.MAX_TOKENS:
		case BedrockStopReason.MODEL_CONTEXT_WINDOW_EXCEEDED:
			return "length";
		case BedrockStopReason.TOOL_USE:
			return "toolUse";
		default:
			return "error";
	}
}

/**
 *
 */
function getConfiguredBedrockRegion(options: BedrockOptions): string | undefined {
	if (typeof process === "undefined") {
		return options.region;
	}

	// eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty string must fall through to next fallback
	return options.region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || undefined;
}

/**
 *
 */
function hasConfiguredBedrockProfile(): boolean {
	if (typeof process === "undefined") {
		return false;
	}

	return Boolean(process.env.AWS_PROFILE);
}

/**
 *
 */
function getStandardBedrockEndpointRegion(baseUrl: string | undefined): string | undefined {
	if (!baseUrl) {
		return undefined;
	}

	try {
		const { hostname } = new URL(baseUrl);
		const match = hostname.toLowerCase().match(/^bedrock-runtime(?:-fips)?\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?$/);
		return match?.[1];
	} catch {
		return undefined;
	}
}

/**
 *
 */
function shouldUseExplicitBedrockEndpoint(
	baseUrl: string,
	configuredRegion: string | undefined,
	hasConfiguredProfile: boolean,
): boolean {
	const endpointRegion = getStandardBedrockEndpointRegion(baseUrl);
	if (!endpointRegion) {
		return true;
	}

	return !configuredRegion && !hasConfiguredProfile;
}

/**
 *
 */
function isGovCloudBedrockTarget(model: Model<"bedrock-converse-stream">, options: BedrockOptions): boolean {
	const region = getConfiguredBedrockRegion(options);
	if (region?.toLowerCase().startsWith("us-gov-")) {
		return true;
	}

	const modelId = model.id.toLowerCase();
	return modelId.startsWith("us-gov.") || modelId.startsWith("arn:aws-us-gov:");
}

/**
 *
 */
function buildAdditionalModelRequestFields(
	model: Model<"bedrock-converse-stream">,
	options: BedrockOptions,
): DocumentType | undefined {
	if (!options.reasoning || !model.reasoning) return undefined;
	if (!isAnthropicClaudeModel(model)) return undefined;

	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- guard above narrows reasoning to ThinkingLevel
	return buildClaudeThinkingFields(model, options as BedrockOptions & { reasoning: ThinkingLevel });
}

/**
 *
 */
function buildClaudeThinkingFields(
	model: Model<"bedrock-converse-stream">,
	options: BedrockOptions & { reasoning: ThinkingLevel },
): Record<string, DocumentType> {
	// GovCloud Bedrock currently rejects the Claude thinking.display field.
	// Omit it there until the GovCloud Converse schema catches up.
	const display = isGovCloudBedrockTarget(model, options) ? undefined : (options.thinkingDisplay ?? "summarized");

	const result: Record<string, DocumentType> = supportsAdaptiveThinking(model.id, model.name)
		? buildAdaptiveThinkingFields(model, options, display)
		: buildLegacyThinkingFields(options, display);

	if (!supportsAdaptiveThinking(model.id, model.name) && (options.interleavedThinking ?? true)) {
		result.anthropic_beta = ["interleaved-thinking-2025-05-14"];
	}

	return result;
}

/**
 *
 */
function buildAdaptiveThinkingFields(
	model: Model<"bedrock-converse-stream">,
	options: BedrockOptions & { reasoning: ThinkingLevel },
	display: BedrockThinkingDisplay | undefined,
): Record<string, DocumentType> {
	return {
		thinking: { type: "adaptive", ...(display !== undefined ? { display } : {}) },
		output_config: { effort: mapThinkingLevelToEffort(model, options.reasoning) },
	};
}

/**
 *
 */
function buildLegacyThinkingFields(
	options: BedrockOptions & { reasoning: ThinkingLevel },
	display: BedrockThinkingDisplay | undefined,
): Record<string, DocumentType> {
	const defaultBudgets: Record<ThinkingLevel, number> = {
		minimal: 1024,
		low: 2048,
		medium: 8192,
		high: 16384,
		xhigh: 16384, // Claude doesn't support xhigh, clamp to high
	};

	// Custom budgets override defaults (xhigh not in ThinkingBudgets, use high)
	const level = options.reasoning === "xhigh" ? "high" : options.reasoning;
	const budget = options.thinkingBudgets?.[level] ?? defaultBudgets[options.reasoning];

	return {
		thinking: {
			type: "enabled",
			budget_tokens: budget,
			...(display !== undefined ? { display } : {}),
		},
	};
}

/**
 *
 */
function createImageBlock(mimeType: string, data: string) {
	let format: ImageFormat;
	switch (mimeType) {
		case "image/jpeg":
		case "image/jpg":
			format = ImageFormat.JPEG;
			break;
		case "image/png":
			format = ImageFormat.PNG;
			break;
		case "image/gif":
			format = ImageFormat.GIF;
			break;
		case "image/webp":
			format = ImageFormat.WEBP;
			break;
		default:
			throw new Error(`Unknown image type: ${mimeType}`);
	}

	const binaryString = atob(data);
	const bytes = new Uint8Array(binaryString.length);
	for (let i = 0; i < binaryString.length; i++) {
		bytes[i] = binaryString.charCodeAt(i);
	}

	return { source: { bytes }, format };
}
