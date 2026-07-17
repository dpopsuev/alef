import type { EventMessage } from "@dpopsuev/alef-kernel/bus";
import type { Message } from "@dpopsuev/alef-ai/types";
import type { ToolCall } from "../stream-turn.js";
import { payloadToText } from "../tool-dispatch.js";
// ToolResultOffloader: Automatic offloading for large tool results
import { checkAndOffloadContent, formatOffloadedReference } from "@dpopsuev/alef-session/context/offloader";

/** Append tool-result messages to the conversation for each completed tool call. */
export async function appendToolResults(
	messages: Message[],
	toolCalls: ToolCall[],
	results: EventMessage[],
	toMotorName: (n: string) => string,
	sessionId: string | undefined,
): Promise<void> {
	for (const [toolCall, result] of toolCalls.map((tc, i) => [tc, results[i]!] as const)) {
		const textContent = payloadToText(result.payload, result.isError, result.errorMessage, toolCall.name);
		
		// Check if content should be offloaded
		let finalText = textContent;
		if (sessionId && !result.isError) {
			const offloadResult = await checkAndOffloadContent(textContent, sessionId, toolCall.id);
			if (offloadResult.offloaded) {
				finalText = formatOffloadedReference(offloadResult);
			}
		}
		
		messages.push({
			role: "toolResult",
			toolCallId: toolCall.id,
			toolName: toMotorName(toolCall.name),
			content: [{ type: "text", text: finalText }],
			isError: result.isError,
			timestamp: Date.now(),
		});
	}
}
