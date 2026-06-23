import type { EventHandlerCtx } from "@dpopsuev/alef-kernel";
import type { AssistantMessage, Message } from "@dpopsuev/alef-llm";
import type { TokenUsage } from "../tool-events.js";
import { serializeConversationHistory } from "./message-handler.js";

type MotorBus = EventHandlerCtx["command"];

const LLM_RESPONSE = "llm.response";

function extractText(message: AssistantMessage): string {
	return message.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("");
}

export function reportUsage(finalMessage: AssistantMessage): TokenUsage | undefined {
	if (!finalMessage.usage) return undefined;
	return {
		input: finalMessage.usage.input,
		output: finalMessage.usage.output,
		totalTokens: finalMessage.usage.totalTokens ?? finalMessage.usage.input + finalMessage.usage.output,
	};
}

export function publishReply(
	motor: MotorBus,
	correlationId: string,
	finalMessage: AssistantMessage,
	messages: Message[],
): void {
	const text = extractText(finalMessage);
	if (text) {
		motor.publish({
			type: LLM_RESPONSE,
			payload: { text, conversationHistory: serializeConversationHistory(messages), usage: finalMessage.usage },
			correlationId,
		});
	} else {
		const fallback =
			finalMessage.errorMessage || (finalMessage.stopReason === "error" ? "An error occurred." : "(no response)");
		motor.publish({ type: LLM_RESPONSE, payload: { text: fallback }, correlationId });
	}
}
