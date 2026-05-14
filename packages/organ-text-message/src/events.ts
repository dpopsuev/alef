import type { ToolDefinition } from "@dpopsuev/alef-spine";

declare module "@dpopsuev/alef-spine" {
	interface SenseEventRegistry {
		/** TextMessageOrgan delivers a prompt to LLMOrgan. */
		"llm.prompt": { messages: readonly unknown[]; tools: readonly ToolDefinition[] };
	}
	interface MotorEventRegistry {
		/** LLMOrgan delivers its text reply — TextMessageOrgan routes to Corpus. */
		"text.message": { text: string };
	}
}
