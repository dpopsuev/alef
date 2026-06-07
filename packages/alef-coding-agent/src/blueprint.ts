import type { CompiledAgentDefinition } from "@dpopsuev/alef-agent-blueprint";

export const CODING_AGENT_BLUEPRINT: CompiledAgentDefinition = {
	name: "alef-coding-agent",
	organs: [
		{ name: "fs", actions: [], toolNames: [] },
		{ name: "shell", actions: [], toolNames: [] },
		{ name: "nodesh", actions: [], toolNames: [] },
		{ name: "lector", actions: [], toolNames: [] },
		{ name: "web", actions: [], toolNames: [] },
		{ name: "delegate", actions: [], toolNames: [] },
		{ name: "orchestration", actions: [], toolNames: [] },
		{ name: "factory", actions: [], toolNames: [] },
		{ name: "skills", actions: [], toolNames: [] },
	],
	model: undefined,
	children: [],
	surfaces: [],
	capabilities: { tools: [], orchestration: true },
	memory: { session: "memory", working: {} },
	policies: { appendSystemPrompt: [] },
	hooks: { extensions: [] },
};
