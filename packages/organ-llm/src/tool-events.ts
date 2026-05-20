export interface ToolCallStart {
	callId: string;
	name: string;
	args: Record<string, unknown>;
}

export interface ToolCallEnd {
	callId: string;
	elapsedMs: number;
	ok: boolean;
	/** Text content from the Sense event payload — what the organ actually returned. */
	result?: string;
}

export interface TokenUsage {
	input: number;
	output: number;
}
