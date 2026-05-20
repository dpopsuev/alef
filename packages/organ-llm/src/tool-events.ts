export interface ToolCallStart {
	callId: string;
	name: string;
	args: Record<string, unknown>;
}

export interface ToolCallEnd {
	callId: string;
	elapsedMs: number;
	ok: boolean;
}

export interface TokenUsage {
	input: number;
	output: number;
}
