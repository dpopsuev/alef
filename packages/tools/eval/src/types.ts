export interface EvalPrompt {
	role: "user" | "system";
	text: string;
}

export type Validator =
	| { type: "contains"; value: string }
	| { type: "not_contains"; value: string }
	| { type: "tool_called"; value: string }
	| { type: "exit_code"; value: string };

export interface EvalResult {
	passed: boolean;
	/** 0–100. Set by LLM judge. 0 on structural failure (judge not called). */
	score: number;
	failures: string[];
	reasoning: string;
	transcript: TranscriptEvent[];
}

export interface TranscriptEvent {
	bus: string;
	type: string;
	text?: string;
}
