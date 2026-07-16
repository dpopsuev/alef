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

/** Live snapshot emitted while a streaming tool is still in flight. */
export interface ToolProgress {
	callId: string;
	name: string;
	elapsedMs: number;
	outputTail?: string;
	lastOutputMs?: number;
	processAlive?: boolean;
	cpuActive?: boolean;
	classification?: string;
}

/** Heartbeat emitted when a tool is quiet but still reporting health. */
export interface ToolHeartbeat {
	callId: string;
	name: string;
	elapsedMs: number;
	outputTail?: string;
	lastOutputMs?: number;
	processAlive?: boolean;
	cpuActive?: boolean;
	classification?: string;
}

/** Supervision wake-up emitted when a tool needs a decision rather than a hard failure. */
export interface ToolWake {
	callId: string;
	name: string;
	elapsedMs: number;
	reason: "slow" | "stall" | "protocol";
	outputTail?: string;
	lastOutputMs?: number;
	processAlive?: boolean;
	cpuActive?: boolean;
	classification?: string;
	availableActions: Array<"wait" | "inspect" | "cancel" | "extend">;
}

/** Notification emitted when supervision extends its patience budget. */
export interface ToolBudgetExtended {
	callId: string;
	name: string;
	extendMs: number;
	wakeAfterMs: number;
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
	| ({ type: "tool-progress" } & ToolProgress)
	| ({ type: "tool-heartbeat" } & ToolHeartbeat)
	| ({ type: "tool-wake" } & ToolWake)
	| ({ type: "tool-budget-extended" } & ToolBudgetExtended)
	| { type: "tool-validation-error"; callId: string; field: string; message: string }
	| { type: "tool-stall"; callId: string; name: string; elapsedMs: number; lastChunkMs: number }
	| { type: "token-usage"; usage: TokenUsage }
	| { type: "chunk"; text: string }
	| { type: "thinking"; text: string }
	| { type: "turn-error"; message: string }
	| { type: "message-queued"; queueLength: number; text?: string; mode?: "steer" | "followUp" | "nextTurn" };
