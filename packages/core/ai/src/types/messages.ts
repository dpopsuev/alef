/**
 * Message type definitions
 */

import type { TSchema } from "typebox";
import type { ImageContent, TextContent, ThinkingContent, ToolCall } from "./content.js";
import type { Api, Provider } from "./providers.js";
import type { StopReason, Usage } from "./usage.js";
import type { AssistantMessageDiagnostic } from "../utils/diagnostics.js";

/**
 *
 */
export interface UserMessage {
	role: "user";
	content: string | (TextContent | ImageContent)[];
	timestamp: number; // Unix timestamp in milliseconds
}

/**
 *
 */
export interface AssistantMessage {
	role: "assistant";
	content: (TextContent | ThinkingContent | ToolCall)[];
	api: Api;
	provider: Provider;
	model: string;
	responseModel?: string; // Concrete `chunk.model` when different from the requested `model` (e.g. OpenRouter `auto` -> `anthropic/...`)
	responseId?: string; // Provider-specific response/message identifier when the upstream API exposes one
	diagnostics?: AssistantMessageDiagnostic[]; // Redacted provider/runtime diagnostics for failures and recoveries.
	usage: Usage;
	stopReason: StopReason;
	errorMessage?: string;
	timestamp: number; // Unix timestamp in milliseconds
}

/**
 *
 */
export interface ToolResultMessage<TDetails = unknown> {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (TextContent | ImageContent)[]; // Supports text and images
	details?: TDetails;
	isError: boolean;
	timestamp: number; // Unix timestamp in milliseconds
}

/**
 *
 */
export type Message = UserMessage | AssistantMessage | ToolResultMessage;

/**
 *
 */
export interface Tool<TParameters extends TSchema = TSchema> {
	name: string;
	description: string;
	parameters: TParameters;
}

/**
 *
 */
export interface Context {
	systemPrompt?: string;
	messages: Message[];
	tools?: Tool[];
}
