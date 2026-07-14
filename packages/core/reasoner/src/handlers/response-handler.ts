import type { EventHandlerCtx } from "@dpopsuev/alef-kernel/adapter";
import type { AssistantMessage, Message } from "@dpopsuev/alef-ai/types";
import type { TokenUsage } from "../tool-events.js";
import { serializeConversationHistory } from "./message-handler.js";

type MotorBus = EventHandlerCtx["bus"]["command"];

const LLM_RESPONSE = "llm.response";

/** Concatenate all text content blocks from an assistant message into a single string. */
function extractText(message: AssistantMessage): string {
	return message.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("");
}

/** Extract token-usage metrics from a completed assistant message. */
export function reportUsage(finalMessage: AssistantMessage, modelId?: string): TokenUsage {
	return {
		input: finalMessage.usage.input,
		output: finalMessage.usage.output,
		totalTokens: finalMessage.usage.totalTokens,
		costUsd: finalMessage.usage.cost.total,
		cacheRead: finalMessage.usage.cacheRead,
		cacheWrite: finalMessage.usage.cacheWrite,
		modelId,
	};
}

/** Publish the final llm.response command with extracted text and serialized conversation history. */
export function publishReply(
	command: MotorBus,
	correlationId: string,
	finalMessage: AssistantMessage,
	messages: Message[],
): void {
	const text = extractText(finalMessage);
	if (text) {
		command.publish({
			type: LLM_RESPONSE,
			payload: { text, conversationHistory: serializeConversationHistory(messages), usage: finalMessage.usage },
			correlationId,
		});
	} else {
		const fallback =
			finalMessage.errorMessage ?? (finalMessage.stopReason === "error" ? "An error occurred." : "(no response)");
		command.publish({ type: LLM_RESPONSE, payload: { text: fallback }, correlationId });
	}
}
