import type { ToolDefinition } from "@dpopsuev/alef-kernel/adapter";

declare module "@dpopsuev/alef-kernel" {
	interface MotorEventRegistry {
		/** AgentController delivers a user message to the agent. */
		"text.input": { text: string; tools: ToolDefinition[] };
	}
	interface SenseEventRegistry {
		/** Agent delivers reply via AgentController. */
		"text.message": { text: string };
	}
}
