import type { MotorEvent, SensePublishInput } from "./buses.js";

export function extractToolCallId(payload: Record<string, unknown>): string | undefined {
	return typeof payload.toolCallId === "string" ? payload.toolCallId : undefined;
}

export function toErrorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export function buildSense(
	motor: MotorEvent,
	payload: Record<string, unknown>,
	isError = false,
	errorMessage?: string,
): SensePublishInput {
	const toolCallId = extractToolCallId(motor.payload);
	return {
		type: motor.type,
		correlationId: motor.correlationId,
		payload: toolCallId ? { ...payload, toolCallId } : payload,
		isError,
		errorMessage,
	};
}

export function buildErrSense(motor: MotorEvent, message: string): SensePublishInput {
	const toolCallId = extractToolCallId(motor.payload);
	return {
		type: motor.type,
		correlationId: motor.correlationId,
		payload: toolCallId ? { toolCallId } : {},
		isError: true,
		errorMessage: message,
	};
}
