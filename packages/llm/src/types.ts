/**
 * Unified types module - re-exports all types from domain-focused modules
 * This maintains API compatibility while reducing coupling
 */

// Re-export from content module
export type {
	ImageContent,
	TextContent,
	TextSignatureV1,
	ThinkingContent,
	ToolCall,
} from "./types-content.js";
// Re-export from events module
export type { AssistantMessageEvent } from "./types-events.js";
// Re-export from functions module
export type {
	ImagesFunction,
	StreamFunction,
} from "./types-functions.js";
// Re-export from images module
export type {
	AssistantImages,
	ImagesContext,
	ImagesInputContent,
	ImagesModel,
	ImagesOutputContent,
} from "./types-images.js";

// Re-export from messages module
export type {
	AssistantMessage,
	Context,
	Message,
	Tool,
	ToolResultMessage,
	UserMessage,
} from "./types-messages.js";
// Re-export from models module (includes compat types)
export type {
	AnthropicMessagesCompat,
	Model,
	ModelThinkingLevel,
	OpenAICompletionsCompat,
	OpenAIResponsesCompat,
	OpenRouterRouting,
	ThinkingBudgets,
	ThinkingLevel,
	ThinkingLevelMap,
	VercelGatewayRouting,
} from "./types-models.js";
// Re-export from options module
export type {
	CacheRetention,
	ImagesOptions,
	ProviderImagesOptions,
	ProviderResponse,
	ProviderStreamOptions,
	SimpleStreamOptions,
	StreamOptions,
	Transport,
} from "./types-options.js";
// Re-export from providers module
export type {
	Api,
	ImagesApi,
	ImagesProvider,
	KnownApi,
	KnownImagesApi,
	KnownImagesProvider,
	KnownProvider,
	Provider,
} from "./types-providers.js";
// Re-export from usage module
export type {
	ImagesStopReason,
	StopReason,
	Usage,
} from "./types-usage.js";
// Re-export external types that were previously imported
export type { AssistantMessageEventStream } from "./utils/event-stream.js";
