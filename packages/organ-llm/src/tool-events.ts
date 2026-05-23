export interface ToolCallStart {
	callId: string;
	name: string;
	args: Record<string, unknown>;
}

export interface ToolCallEnd {
	callId: string;
	elapsedMs: number;
	ok: boolean;
	/** Raw text encoded for LLM context (payloadToText output). Used as TUI fallback. */
	result?: string;
	/** Human-readable display text from the organ's _display block. Shown in TUI instead of result. */
	display?: string;
	/** MIME type of display, e.g. "text/x-diff". Tells the TUI how to render display. */
	displayKind?: string;
}

export interface TokenUsage {
	input: number;
	output: number;
}
