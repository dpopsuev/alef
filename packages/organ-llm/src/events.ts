declare module "@dpopsuev/alef-spine" {
	interface SenseEventRegistry {
		/** CorpusOrgans deliver tool execution results to LLMOrgan. */
		"llm.tool_result": {
			toolName: string;
			toolCallId: string;
			result: unknown;
			isError: boolean;
		};
	}
	interface MotorEventRegistry {
		/** LLMOrgan invokes a tool — routed to the subscribing CorpusOrgan by toolName. */
		"llm.tool_call": {
			toolName: string;
			toolCallId: string;
			args: Record<string, unknown>;
		};
	}
}
