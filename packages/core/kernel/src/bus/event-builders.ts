import type { CommandMessage, EventInput } from "./messages.js";
import type { DomainCondition } from "../reconciliation.js";

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
	const rawConditions = payload.conditions;
	const conditions = Array.isArray(rawConditions)
		? // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- tool results may attach DomainCondition[]
			(rawConditions as DomainCondition[])
		: undefined;
	return {
		type: command.type,
		correlationId: command.correlationId,
		payload: toolCallId ? { ...payload, toolCallId } : payload,
		isError,
		errorMessage,
		...(conditions && conditions.length > 0 ? { conditions } : {}),
	};
}

/** Construct an error event from a command with the given error message. */
export function buildErrorResult(
	command: CommandMessage,
	message: string,
	extraPayload: Record<string, unknown> = {},
): EventInput {
	const toolCallId = extractToolCallId(command.payload);
	return {
		type: command.type,
		correlationId: command.correlationId,
		payload: toolCallId ? { ...extraPayload, toolCallId } : { ...extraPayload },
		isError: true,
		errorMessage: message,
	};
}

