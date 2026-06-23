import type { CommandMessage, EventInput } from "./buses.js";
import { getErrorMessage } from "./errors.js";

export function extractToolCallId(payload: Record<string, unknown>): string | undefined {
	return typeof payload.toolCallId === "string" ? payload.toolCallId : undefined;
}

/**
 * @deprecated Use getErrorMessage from "./errors.js" instead.
 * Kept for backward compatibility during migration.
 */
export function toErrorMessage(err: unknown): string {
	return getErrorMessage(err);
}

export function buildSense(
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

export function buildErrSense(command: CommandMessage, message: string): EventInput {
	const toolCallId = extractToolCallId(command.payload);
	return {
		type: command.type,
		correlationId: command.correlationId,
		payload: toolCallId ? { toolCallId } : {},
		isError: true,
		errorMessage: message,
	};
}
