import type { CommandMessage, EventInput } from "./messages.js";

/** Pluck toolCallId if the payload carries one (not all messages do). */
export function extractToolCallId(payload: Record<string, unknown>): string | undefined {
	return typeof payload.toolCallId === "string" ? payload.toolCallId : undefined;
}

/** Construct a success or error event from a command, forwarding its correlation and toolCallId. */
export function buildEventResult(
	command: CommandMessage,
	payload: Record<string, unknown>,
	isError = false,
	errorMessage?: string,
): EventInput {
	const toolCallId = extractToolCallId(command.payload);
	return {
		type: command.type,
		correlationId: command.correlationId,
		payload: toolCallId ? { ...payload, toolCallId } : payload,
		isError,
		errorMessage,
	};
}

/** Construct an error event from a command with the given error message. */
export function buildErrorResult(command: CommandMessage, message: string): EventInput {
	const toolCallId = extractToolCallId(command.payload);
	return {
		type: command.type,
		correlationId: command.correlationId,
		payload: toolCallId ? { toolCallId } : {},
		isError: true,
		errorMessage: message,
	};
}

