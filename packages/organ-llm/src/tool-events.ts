export interface ToolCallStart {
	callId: string;
	name: string;
	args: Record<string, unknown>;
}

export interface ToolCallEnd {
	callId: string;
	elapsedMs: number;
	ok: boolean;
	result?: string;
	display?: string;
	displayKind?: string;
}

export interface TokenUsage {
	input: number;
	output: number;
	totalTokens: number;
}

export type CerebrumEvent =
	| ({ type: "tool-start" } & ToolCallStart)
	| ({ type: "tool-end" } & ToolCallEnd)
	| { type: "token-usage"; usage: TokenUsage }
	| { type: "chunk"; text: string }
	| { type: "thinking"; text: string };
