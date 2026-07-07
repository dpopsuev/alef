import type OpenAI from "openai";
import type {
	ChatCompletionAssistantMessageParam,
	ChatCompletionContentPart,
	ChatCompletionContentPartImage,
	ChatCompletionContentPartText,
	ChatCompletionDeveloperMessageParam,
	ChatCompletionMessageParam,
	ChatCompletionSystemMessageParam,
	ChatCompletionToolMessageParam,
} from "openai/resources/chat/completions.js";
import type {
	AssistantMessage,
	CacheRetention,
	Context,
	ImageContent,
	Message,
	Model,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from "../../types.js";
import { sanitizeSurrogates } from "../../utils/sanitize-unicode.js";
import { transformMessages } from "../normalize-messages.js";
import type { ResolvedOpenAICompletionsCompat } from "./completions-compat.js";

// ---------------------------------------------------------------------------
// Private types
// ---------------------------------------------------------------------------

interface OpenAICompatCacheControl {
	type: "ephemeral";
	ttl?: string;
}

type ChatCompletionInstructionMessageParam = ChatCompletionDeveloperMessageParam | ChatCompletionSystemMessageParam;

type ChatCompletionTextPartWithCacheControl = ChatCompletionContentPartText & {
	cache_control?: OpenAICompatCacheControl;
};

type ChatCompletionToolWithCacheControl = OpenAI.Chat.Completions.ChatCompletionTool & {
	cache_control?: OpenAICompatCacheControl;
};

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

/**
 * Check if conversation messages contain tool calls or tool results.
 * This is needed because Anthropic (via proxy) requires the tools param
 * to be present when messages include tool_calls or tool role messages.
 */
export function hasToolHistory(messages: Message[]): boolean {
	for (const msg of messages) {
		if (msg.role === "toolResult") {
			return true;
		}
		if (msg.role === "assistant") {
			if (msg.content.some((block) => block.type === "toolCall")) {
				return true;
			}
		}
	}
	return false;
}

/**
 *
 */
export function isTextContentBlock(block: { type: string }): block is TextContent {
	return block.type === "text";
}

/**
 *
 */
export function isThinkingContentBlock(block: { type: string }): block is ThinkingContent {
	return block.type === "thinking";
}

/**
 *
 */
export function isToolCallBlock(block: { type: string }): block is ToolCall {
	return block.type === "toolCall";
}

/**
 *
 */
export function isImageContentBlock(block: { type: string }): block is ImageContent {
	return block.type === "image";
}

// ---------------------------------------------------------------------------
// Cache retention
// ---------------------------------------------------------------------------

/**
 *
 */
export function resolveCacheRetention(cacheRetention?: CacheRetention): CacheRetention {
	if (cacheRetention) {
		return cacheRetention;
	}
	if (typeof process !== "undefined" && process.env.ALEF_CACHE_RETENTION === "long") {
		return "long";
	}
	return "short";
}

/**
 *
 */
export function getCompatCacheControl(
	compat: ResolvedOpenAICompletionsCompat,
	cacheRetention: CacheRetention,
): OpenAICompatCacheControl | undefined {
	if (compat.cacheControlFormat !== "anthropic" || cacheRetention === "none") {
		return undefined;
	}

	const ttl = cacheRetention === "long" && compat.supportsLongCacheRetention ? "1h" : undefined;
	return { type: "ephemeral", ...(ttl ? { ttl } : {}) };
}

// ---------------------------------------------------------------------------
// Anthropic-style cache control
// ---------------------------------------------------------------------------

/**
 *
 */
export function applyAnthropicCacheControl(
	messages: ChatCompletionMessageParam[],
	tools: OpenAI.Chat.Completions.ChatCompletionTool[] | undefined,
	cacheControl: OpenAICompatCacheControl,
): void {
	addCacheControlToSystemPrompt(messages, cacheControl);
	addCacheControlToLastTool(tools, cacheControl);
	addCacheControlToLastConversationMessage(messages, cacheControl);
}

/**
 *
 */
function addCacheControlToSystemPrompt(
	messages: ChatCompletionMessageParam[],
	cacheControl: OpenAICompatCacheControl,
): void {
	for (const message of messages) {
		if (message.role === "system" || message.role === "developer") {
			addCacheControlToInstructionMessage(message, cacheControl);
			return;
		}
	}
}

/**
 *
 */
function addCacheControlToLastConversationMessage(
	messages: ChatCompletionMessageParam[],
	cacheControl: OpenAICompatCacheControl,
): void {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "user" || message.role === "assistant") {
			if (addCacheControlToMessage(message, cacheControl)) {
				return;
			}
		}
	}
}

/**
 *
 */
function addCacheControlToLastTool(
	tools: OpenAI.Chat.Completions.ChatCompletionTool[] | undefined,
	cacheControl: OpenAICompatCacheControl,
): void {
	if (!tools || tools.length === 0) {
		return;
	}

	const lastTool = tools[tools.length - 1] as ChatCompletionToolWithCacheControl;
	lastTool.cache_control = cacheControl;
}

/**
 *
 */
function addCacheControlToInstructionMessage(
	message: ChatCompletionInstructionMessageParam,
	cacheControl: OpenAICompatCacheControl,
): boolean {
	return addCacheControlToTextContent(message, cacheControl);
}

/**
 *
 */
function addCacheControlToMessage(
	message: ChatCompletionMessageParam,
	cacheControl: OpenAICompatCacheControl,
): boolean {
	if (message.role === "user" || message.role === "assistant") {
		return addCacheControlToTextContent(message, cacheControl);
	}
	return false;
}

/**
 *
 */
function addCacheControlToTextContent(
	message:
		| ChatCompletionInstructionMessageParam
		| ChatCompletionAssistantMessageParam
		| Extract<ChatCompletionMessageParam, { role: "user" }>,
	cacheControl: OpenAICompatCacheControl,
): boolean {
	const content = message.content;
	if (typeof content === "string") {
		if (content.length === 0) {
			return false;
		}
		message.content = [
			{
				type: "text",
				text: content,
				cache_control: cacheControl,
			},
		] as ChatCompletionTextPartWithCacheControl[];
		return true;
	}

	if (!Array.isArray(content)) {
		return false;
	}

	for (let i = content.length - 1; i >= 0; i--) {
		const part = content[i];
		if (part.type === "text") {
			const textPart = part as ChatCompletionTextPartWithCacheControl;
			textPart.cache_control = cacheControl;
			return true;
		}
	}

	return false;
}

// ---------------------------------------------------------------------------
// convertMessages
// ---------------------------------------------------------------------------

/**
 *
 */
export function convertMessages(
	model: Model<"openai-completions">,
	context: Context,
	compat: ResolvedOpenAICompletionsCompat,
): ChatCompletionMessageParam[] {
	const params: ChatCompletionMessageParam[] = [];

	const normalizeToolCallId = (id: string): string => {
		// Handle pipe-separated IDs from OpenAI Responses API
		// Format: {call_id}|{id} where {id} can be 400+ chars with special chars (+, /, =)
		// These come from providers like github-copilot, openai-codex, opencode
		// Extract just the call_id part and normalize it
		if (id.includes("|")) {
			const [callId] = id.split("|");
			// Sanitize to allowed chars and truncate to 40 chars (OpenAI limit)
			// eslint-disable-next-line no-magic-numbers
			return callId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
		}

		// eslint-disable-next-line no-magic-numbers
		if (model.provider === "openai") return id.length > 40 ? id.slice(0, 40) : id;
		return id;
	};

	const transformedMessages = transformMessages(context.messages, model, (id) => normalizeToolCallId(id));

	if (context.systemPrompt) {
		const useDeveloperRole = model.reasoning && compat.supportsDeveloperRole;
		const role = useDeveloperRole ? "developer" : "system";
		params.push({ role: role, content: sanitizeSurrogates(context.systemPrompt) });
	}

	let lastRole: string | null = null;

	// -----------------------------------------------------------------------
	// Per-role handlers — each returns whether lastRole was already set
	// (i.e. the caller should skip the default `lastRole = msg.role`).
	// The toolResult handler also advances the loop index via the cursor.
	// -----------------------------------------------------------------------

	/**
	 *
	 */
	function handleUser(msg: UserMessage): boolean {
		if (typeof msg.content === "string") {
			params.push({
				role: "user",
				content: sanitizeSurrogates(msg.content),
			});
		} else {
			const content: ChatCompletionContentPart[] = msg.content.map((item): ChatCompletionContentPart => {
				if (item.type === "text") {
					return {
						type: "text",
						text: sanitizeSurrogates(item.text),
					} satisfies ChatCompletionContentPartText;
				} else {
					return {
						type: "image_url",
						image_url: {
							url: `data:${item.mimeType};base64,${item.data}`,
						},
					} satisfies ChatCompletionContentPartImage;
				}
			});
			if (content.length === 0) return true;
			params.push({
				role: "user",
				content,
			});
		}
		return false;
	}

	/**
	 *
	 */
	function handleAssistant(msg: AssistantMessage): boolean {
		// Some providers don't accept null content, use empty string instead
		const assistantMsg: ChatCompletionAssistantMessageParam = {
			role: "assistant",
			content: compat.requiresAssistantAfterToolResult ? "" : null,
		};

		const assistantTextParts = msg.content
			.filter(isTextContentBlock)
			.filter((block) => block.text.trim().length > 0)
			.map(
				(block) =>
					({
						type: "text",
						text: sanitizeSurrogates(block.text),
					}) satisfies ChatCompletionContentPartText,
			);
		const assistantText = assistantTextParts.map((part) => part.text).join("");

		const nonEmptyThinkingBlocks = msg.content
			.filter(isThinkingContentBlock)
			.filter((block) => block.thinking.trim().length > 0);
		if (nonEmptyThinkingBlocks.length > 0) {
			if (compat.requiresThinkingAsText) {
				// Convert thinking blocks to plain text (no tags to avoid model mimicking them)
				const thinkingText = nonEmptyThinkingBlocks
					.map((block) => sanitizeSurrogates(block.thinking))
					.join("\n\n");
				assistantMsg.content = [{ type: "text", text: thinkingText }, ...assistantTextParts];
			} else {
				// Always send assistant content as a plain string (OpenAI Chat Completions
				// API standard format). Sending as an array of {type:"text", text:"..."}
				// objects is non-standard and causes some models (e.g. DeepSeek V3.2 via
				// NVIDIA NIM) to mirror the content-block structure literally in their
				// output, producing recursive nesting like [{'type':'text','text':'[{...}]'}].
				if (assistantText.length > 0) {
					assistantMsg.content = assistantText;
				}

				// Use the signature from the first thinking block if available (for llama.cpp server + gpt-oss)
				const signature = nonEmptyThinkingBlocks[0].thinkingSignature;
				if (signature && signature.length > 0) {
					// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- provider-specific extension field keyed by thinking signature
					(assistantMsg as unknown as Record<string, string>)[signature] = nonEmptyThinkingBlocks.map((block) => block.thinking).join("\n");
				}
			}
		} else if (assistantText.length > 0) {
			// Always send assistant content as a plain string (OpenAI Chat Completions
			// API standard format). Sending as an array of {type:"text", text:"..."}
			// objects is non-standard and causes some models (e.g. DeepSeek V3.2 via
			// NVIDIA NIM) to mirror the content-block structure literally in their
			// output, producing recursive nesting like [{'type':'text','text':'[{...}]'}].
			assistantMsg.content = assistantText;
		}

		const toolCalls = msg.content.filter(isToolCallBlock);
		if (toolCalls.length > 0) {
			assistantMsg.tool_calls = toolCalls.map((tc) => ({
				id: tc.id,
				type: "function" as const,
				function: {
					name: tc.name,
					arguments: JSON.stringify(tc.arguments),
				},
			}));
			const reasoningDetails = toolCalls
				.filter((tc) => tc.thoughtSignature)
				.map((tc) => {
					try {
						// eslint-disable-next-line @typescript-eslint/no-unsafe-return -- JSON.parse boundary
						return JSON.parse(tc.thoughtSignature!);
					} catch {
						return null;
					}
				})
				.filter(Boolean);
			if (reasoningDetails.length > 0) {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- provider-specific extension field
				(assistantMsg as unknown as Record<string, unknown>).reasoning_details = reasoningDetails;
			}
		}
		if (
			compat.requiresReasoningContentOnAssistantMessages &&
			model.reasoning &&
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- provider-specific extension field
			(assistantMsg as { reasoning_content?: string }).reasoning_content === undefined
		) {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- provider-specific extension field
			(assistantMsg as { reasoning_content?: string }).reasoning_content = "";
		}
		// Skip assistant messages that have no content and no tool calls.
		// Some providers require "either content or tool_calls, but not none".
		// Other providers also don't accept empty assistant messages.
		// This handles aborted assistant responses that got no content.
		const content = assistantMsg.content;
		const hasContent =
			content !== null &&
			content !== undefined &&
			(typeof content === "string" ? content.length > 0 : content.length > 0);
		if (!hasContent && !assistantMsg.tool_calls) {
			return true;
		}
		params.push(assistantMsg);
		return false;
	}

	/**
	 *
	 */
	function handleToolResult(startIndex: number): { skipDefault: boolean; newIndex: number } {
		const imageBlocks: Array<{ type: "image_url"; image_url: { url: string } }> = [];
		let j = startIndex;

		for (; j < transformedMessages.length && transformedMessages[j].role === "toolResult"; j++) {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- role check boundary
			const toolMsg = transformedMessages[j] as ToolResultMessage;

			// Extract text and image content
			const textResult = toolMsg.content
				.filter(isTextContentBlock)
				.map((block) => block.text)
				.join("\n");
			const hasImages = toolMsg.content.some((c) => c.type === "image");

			// Always send tool result with text (or placeholder if only images)
			const hasText = textResult.length > 0;
			// Some providers require the 'name' field in tool results
			const toolResultMsg: ChatCompletionToolMessageParam = {
				role: "tool",
				content: sanitizeSurrogates(hasText ? textResult : "(see attached image)"),
				tool_call_id: toolMsg.toolCallId,
			};
			if (compat.requiresToolResultName && toolMsg.toolName) {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- provider-specific extension field
				(toolResultMsg as unknown as Record<string, string>).name = toolMsg.toolName;
			}
			params.push(toolResultMsg);

			if (hasImages && model.input.includes("image")) {
				for (const block of toolMsg.content) {
					if (isImageContentBlock(block)) {
						imageBlocks.push({
							type: "image_url",
							image_url: {
								url: `data:${block.mimeType};base64,${block.data}`,
							},
						});
					}
				}
			}
		}

		if (imageBlocks.length > 0) {
			if (compat.requiresAssistantAfterToolResult) {
				params.push({
					role: "assistant",
					content: "I have processed the tool results.",
				});
			}

			params.push({
				role: "user",
				content: [
					{
						type: "text",
						text: "Attached image(s) from tool result:",
					},
					...imageBlocks,
				],
			});
			lastRole = "user";
		} else {
			lastRole = "toolResult";
		}

		return { skipDefault: true, newIndex: j - 1 };
	}

	// -----------------------------------------------------------------------
	// Role dispatch table
	// -----------------------------------------------------------------------

	type RoleDispatchResult = { skipDefault: boolean; newIndex?: number };
	const roleHandlers: Record<string, (msg: Message, index: number) => RoleDispatchResult> = {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- dispatch key guarantees role
		user: (msg) => ({ skipDefault: handleUser(msg as UserMessage) }),
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- dispatch key guarantees role
		assistant: (msg) => ({ skipDefault: handleAssistant(msg as AssistantMessage) }),
		toolResult: (_msg, index) => handleToolResult(index),
	};

	for (let i = 0; i < transformedMessages.length; i++) {
		const msg = transformedMessages[i];
		// Some providers don't allow user messages directly after tool results
		// Insert a synthetic assistant message to bridge the gap
		if (compat.requiresAssistantAfterToolResult && lastRole === "toolResult" && msg.role === "user") {
			params.push({
				role: "assistant",
				content: "I have processed the tool results.",
			});
		}

		const handler = roleHandlers[msg.role];
		// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive guard for unknown roles
		if (handler) {
			const result = handler(msg, i);
			if (result.newIndex !== undefined) {
				i = result.newIndex;
			}
			if (result.skipDefault) {
				continue;
			}
		}

		lastRole = msg.role;
	}

	return params;
}

// ---------------------------------------------------------------------------
// convertTools
// ---------------------------------------------------------------------------

/**
 *
 */
export function convertTools(
	tools: Tool[],
	compat: ResolvedOpenAICompletionsCompat,
): OpenAI.Chat.Completions.ChatCompletionTool[] {
	return tools.map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- TypeBox generates JSON Schema compatible with OpenAI
			parameters: tool.parameters as Record<string, unknown>,
			// Only include strict if provider supports it. Some reject unknown fields.
			...(compat.supportsStrictMode !== false && { strict: false }),
		},
	}));
}
