/**
 * Structured tool-failure observations for Binding Constraint H3 closed-loop recovery.
 * Every failed tool injects type / recoverability / suggested next act into the transcript.
 */

/** How recoverable a tool failure is for the next policy act. */
export type ToolErrorRecoverability = "retry" | "fix_args" | "alternate_tool" | "abort" | "unknown";

/** Coarse failure class used in corrective observations. */
export type ToolErrorType =
	| "timeout"
	| "validation"
	| "permission"
	| "not_found"
	| "runtime"
	| "cancelled"
	| "unknown";

/** Corrective observation fed back to the model after a tool failure. */
export interface ToolErrorObservation {
	type: "tool_error";
	tool?: string;
	errorType: ToolErrorType;
	message: string;
	recoverability: ToolErrorRecoverability;
	suggestedNextAct: string;
}

/** Classify a tool failure into a structured observation. */
export function classifyToolError(
	errorMessage: string,
	opts: { tool?: string; payload?: Record<string, unknown> } = {},
): ToolErrorObservation {
	const message = errorMessage.trim() || "unknown tool error";
	const lower = message.toLowerCase();
	const validation = opts.payload?._validationError;

	let errorType: ToolErrorType = "unknown";
	if (validation || lower.includes("validation") || lower.includes("invalid")) errorType = "validation";
	else if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("deadline"))
		errorType = "timeout";
	else if (
		lower.includes("permission") ||
		lower.includes("eacces") ||
		lower.includes("writable root") ||
		lower.includes("not allowed")
	)
		errorType = "permission";
	else if (lower.includes("enoent") || lower.includes("not found") || lower.includes("no such file"))
		errorType = "not_found";
	else if (lower.includes("abort") || lower.includes("cancel")) errorType = "cancelled";
	else errorType = "runtime";

	const recoverability = recoverabilityFor(errorType);
	return {
		type: "tool_error",
		...(opts.tool ? { tool: opts.tool } : {}),
		errorType,
		message,
		recoverability,
		suggestedNextAct: suggestedNextActFor(errorType, opts.tool),
	};
}

/** Map error class → recoverability hint. */
function recoverabilityFor(errorType: ToolErrorType): ToolErrorRecoverability {
	switch (errorType) {
		case "timeout":
			return "retry";
		case "validation":
		case "not_found":
			return "fix_args";
		case "permission":
			return "alternate_tool";
		case "cancelled":
			return "abort";
		case "runtime":
			return "retry";
		default:
			return "unknown";
	}
}

/** Short next-act guidance for the model after a tool failure. */
function suggestedNextActFor(errorType: ToolErrorType, tool?: string): string {
	const toolHint = tool ? ` (${tool})` : "";
	switch (errorType) {
		case "timeout":
			return `Retry with a longer timeout or smaller scope${toolHint}`;
		case "validation":
			return `Fix arguments to match the tool schema${toolHint}`;
		case "permission":
			return `Use a path inside writable roots or a read-only tool${toolHint}`;
		case "not_found":
			return `Verify the path/resource exists, then retry${toolHint}`;
		case "cancelled":
			return "Do not retry the cancelled call; choose a different approach";
		case "runtime":
			return `Inspect the error, adjust inputs, and retry once${toolHint}`;
		default:
			return `Read the error, correct the approach, then continue${toolHint}`;
	}
}

/** Serialize an observation for toolResult content (model-facing). */
export function formatToolErrorObservation(observation: ToolErrorObservation): string {
	return JSON.stringify(observation);
}
