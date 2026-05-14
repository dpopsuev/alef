import type { ToolDefinition } from "@dpopsuev/alef-spine";

declare module "@dpopsuev/alef-spine" {
	interface MotorEventRegistry {
		/** Corpus delivers a user text message to TextMessageOrgan. */
		"text.input": { text: string; tools: ToolDefinition[] };
	}
	interface SenseEventRegistry {
		/** TextMessageOrgan delivers the agent's final reply back to Corpus. */
		"text.reply": { text: string };
	}
}
