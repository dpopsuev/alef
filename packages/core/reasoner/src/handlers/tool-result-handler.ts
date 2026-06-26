import type { EventMessage } from "@dpopsuev/alef-kernel/bus";
import type { Message } from "@dpopsuev/alef-ai/types";
import type { ToolCall } from "../stream-turn.js";
import { payloadToText } from "../tool-dispatch.js";

export function appendToolResults(
	messages: Message[],
	toolCalls: ToolCall[],
	results: EventMessage[],
	toMotorName: (n: string) => string,
): void {
	for (const [toolCall, result] of toolCalls.map((tc, i) => [tc, results[i]] as const)) {
		messages.push({
			role: "toolResult",
			toolCallId: toolCall.id,
			toolName: toMotorName(toolCall.name),
			content: [{ type: "text", text: payloadToText(result.payload, result.isError, result.errorMessage) }],
			isError: result.isError,
			timestamp: Date.now(),
		});
	}
}
