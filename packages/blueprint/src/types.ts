import type {
	AgentActionMetadata,
	AgentCapabilityAvailability,
	AgentCapabilityDefinition,
	AgentCapabilityKind,
	ThinkingLevel,
} from "@dpopsuev/alef-agent-core";

export type { AgentActionMetadata, AgentCapabilityAvailability, AgentCapabilityDefinition, AgentCapabilityKind };

export type AgentRole = "root" | "child";

export interface AgentModelSelector {
	provider: string;
	id: string;
	thinkingLevel?: ThinkingLevel;
}

export type AgentOrganName = "fs" | "shell" | "supervisor";

export interface AgentDefinitionOrganInput {
	name: AgentOrganName;
	actions?: string[];
}

export interface CompiledAgentOrganDefinition {
	name: AgentOrganName;
	actions: string[];
	toolNames: string[];
}

export interface AgentDefinitionChildReference {
	name: string;
	blueprint: string;
}

export interface AgentDefinitionHooks {
	extensions: string[];
}

export interface AgentDefinitionPolicies {
	appendSystemPrompt: string[];
}

export interface AgentDefinitionCapabilities {
	tools: string[];
	supervisor: boolean;
}

export interface AgentDefinitionMemory {
	session: "memory" | "persistent";
	working: Record<string, unknown>;
}

export interface AgentDefinitionInput {
	name: string;
	model?: string | AgentModelSelector;
	systemPrompt?: string;
	organs?: AgentDefinitionOrganInput[];
	capabilities?: {
		tools?: string[];
		supervisor?: boolean;
	};
	memory?: {
		session?: "memory" | "persistent";
		working?: Record<string, unknown>;
	};
	policies?: {
		appendSystemPrompt?: string[];
	};
	hooks?: {
		extensions?: string[];
	};
	children?: AgentDefinitionChildReference[];
}

export interface ResolvedAgentDefinitionChild {
	name: string;
	blueprint: string;
}

export interface CompiledAgentDefinition {
	name: string;
	sourcePath?: string;
	baseDir?: string;
	model?: AgentModelSelector;
	systemPrompt?: string;
	organs: CompiledAgentOrganDefinition[];
	capabilities: AgentDefinitionCapabilities;
	memory: AgentDefinitionMemory;
	policies: AgentDefinitionPolicies;
	hooks: AgentDefinitionHooks;
	children: ResolvedAgentDefinitionChild[];
}
