/** Notification payload emitted when a tool call begins execution. */
export interface ToolCallStart {
	callId: string;
	name: string;
	args: Record<string, unknown>;
}

/** Notification payload emitted when a tool call completes with its result or error. */
export interface ToolCallEnd {
	callId: string;
	elapsedMs: number;
	ok: boolean;
	result?: string;
	display?: string;
	displayKind?: string;
}

/** Aggregated token counts and estimated cost for a single LLM call. */
export interface TokenUsage {
	input: number;
	output: number;
	totalTokens: number;
	costUsd?: number;
	cacheRead?: number;
	cacheWrite?: number;
	modelId?: string;
}

/** Discriminated union of all notification-bus events emitted by the LLM reasoning loop. */
export type LlmEvent =
	| ({ type: "tool-start" } & ToolCallStart)
	| ({ type: "tool-end" } & ToolCallEnd)
	| { type: "tool-chunk"; callId: string; text: string }
	| { type: "tool-validation-error"; callId: string; field: string; message: string }
	| { type: "tool-stall"; callId: string; name: string; elapsedMs: number; lastChunkMs: number }
	| { type: "token-usage"; usage: TokenUsage }
	| { type: "chunk"; text: string }
	| { type: "thinking"; text: string }
	| { type: "turn-error"; message: string }
	| { type: "message-queued"; queueLength: number; text?: string; mode?: "steer" | "followUp" | "nextTurn" };
