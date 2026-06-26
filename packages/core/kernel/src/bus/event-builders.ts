import type { CommandMessage, EventInput } from "./messages.js";
import { getErrorMessage } from "../shared/errors.js";

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

/** @deprecated Use buildEventResult */
export const buildSense = buildEventResult;
/** @deprecated Use buildErrorResult */
export const buildErrSense = buildErrorResult;
