import type { ToolDefinition } from "@dpopsuev/alef-spine";

declare module "@dpopsuev/alef-spine" {
	interface MotorEventRegistry {
		/** DialogOrgan delivers a user message to the agent. */
		"text.input": { text: string; tools: ToolDefinition[] };
	}
	interface SenseEventRegistry {
		/** Agent delivers reply via DialogOrgan. */
		"text.message": { text: string };
	}
}
