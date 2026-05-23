import type {
	AgentActionMetadata,
	AgentCapabilityAvailability,
	AgentCapabilityDefinition,
	AgentCapabilityKind,
	ThinkingLevel,
	ToolExecutionMode,
} from "@dpopsuev/alef-agent-core";

export type { AgentActionMetadata, AgentCapabilityAvailability, AgentCapabilityDefinition, AgentCapabilityKind };

export type AgentRole = "root" | "child";

export interface AgentModelSelector {
	provider: string;
	id: string;
	thinkingLevel?: ThinkingLevel;
}

export type AgentOrganName = "ai" | "discourse" | "fs" | "shell" | "nodesh" | "symbols" | "lector" | "supervisor";

export interface AgentDefinitionOrganCacheInput {
	enabled?: boolean;
	ttlMs?: number;
	maxEntries?: number;
}

export interface AgentDefinitionOrganCacheConfig {
	enabled: boolean;
	ttlMs: number;
	maxEntries: number;
}

export interface AgentDefinitionLectorRuntimeInput {
	lsp?: {
		enabled?: boolean;
		command?: string;
	};
	treeSitter?: {
		enabled?: boolean;
	};
	indexing?: {
		preload?: "none" | "workspace";
	};
}

export interface AgentDefinitionLectorRuntimeConfig {
	lsp: {
		enabled: boolean;
		command: string;
	};
	treeSitter: {
		enabled: boolean;
	};
	indexing: {
		preload: "none" | "workspace";
	};
}

export interface AgentDefinitionOrganInput {
	name: AgentOrganName;
	actions?: string[];
	cache?: AgentDefinitionOrganCacheInput;
	runtime?: AgentDefinitionLectorRuntimeInput;
}

export interface CompiledAgentOrganDefinition {
	name: AgentOrganName;
	actions: string[];
	toolNames: string[];
	cache?: AgentDefinitionOrganCacheConfig;
	runtime?: AgentDefinitionLectorRuntimeConfig;
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

export type AgentLoopStrategy = "default" | "minimal" | "ablation";

export type AgentLoopStopOnBudgetAction = "inform" | "warn" | "throttle" | "abort";

export interface AgentDefinitionLoopAblationConfig {
	disableSteering: boolean;
	disableFollowUp: boolean;
	forceSequentialTools: boolean;
}

export interface AgentDefinitionLoopConfig {
	strategy?: AgentLoopStrategy;
	steeringMode?: "all" | "one-at-a-time";
	followUpMode?: "all" | "one-at-a-time";
	toolExecution?: ToolExecutionMode;
	maxTurnsPerRun?: number;
	stopOnBudgetAction?: AgentLoopStopOnBudgetAction;
	ablation?: AgentDefinitionLoopAblationConfig;
}

export type AgentDelegationMode = "off" | "manual" | "auto";

export interface AgentDefinitionDelegationConfig {
	mode: AgentDelegationMode;
}

export type SupervisorUpgradePolicy = "rebuild_only" | "packages" | "self";

export interface AgentDefinitionSupervisorPolicyInput {
	heartbeatIntervalMs?: number;
	heartbeatTimeoutMs?: number;
	maxMissedHeartbeats?: number;
	smokeTestTimeoutMs?: number;
	handoffTimeoutMs?: number;
	maxFixIterations?: number;
	upgradePolicy?: SupervisorUpgradePolicy;
}

export interface AgentDefinitionSupervisorPolicyConfig {
	heartbeatIntervalMs: number;
	heartbeatTimeoutMs: number;
	maxMissedHeartbeats: number;
	smokeTestTimeoutMs: number;
	handoffTimeoutMs: number;
	maxFixIterations: number;
	upgradePolicy: SupervisorUpgradePolicy;
}

export interface AgentDefinitionCapabilities {
	tools: string[];
	supervisor: boolean;
}

export interface AgentDefinitionMemory {
	session: "memory" | "persistent";
	working: Record<string, unknown>;
}

export interface AgentDefinitionPackageSourceInput {
	source: string;
	extensions?: string[];
	skills?: string[];
	prompts?: string[];
	themes?: string[];
}

export type AgentDefinitionPackageSource = string | AgentDefinitionPackageSourceInput;

export interface AgentDefinitionDependenciesInput {
	packages?: AgentDefinitionPackageSource[];
	extensions?: string[];
	skills?: string[];
	prompts?: string[];
	themes?: string[];
}

export interface AgentDefinitionDependenciesConfig {
	packages: AgentDefinitionPackageSource[];
	extensions: string[];
	skills: string[];
	prompts: string[];
	themes: string[];
}

export interface AgentResourceMetadata {
	name?: string;
	labels: Record<string, string>;
	annotations: Record<string, string>;
}

export interface AgentResourceConfig {
	apiVersion: string;
	kind: string;
	metadata: AgentResourceMetadata;
}

export interface AgentDefinitionSurfaceInput {
	/** Transport type. Currently only 'sse' is supported (via RouterOrgan). */
	type: "sse";
	/**
	 * Event type allowlist. Only motor/sense events whose type matches one of
	 * these patterns are forwarded to connected clients.
	 *
	 * Patterns support a single trailing wildcard: 'fs.*' matches 'fs.read',
	 * 'fs.write', etc. Use '*' alone to pass all events.
	 *
	 * Omit or set to [] to forward all events (open broadcast).
	 */
	events?: string[];
}

export interface AgentDefinitionInput {
	name: string;
	model?: string | AgentModelSelector;
	systemPrompt?: string;
	organs?: AgentDefinitionOrganInput[];
	/** Event surface declarations — controls what the RouterOrgan broadcasts. */
	surfaces?: AgentDefinitionSurfaceInput[];
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
	loop?: {
		strategy?: AgentLoopStrategy;
		steeringMode?: "all" | "one-at-a-time";
		followUpMode?: "all" | "one-at-a-time";
		toolExecution?: ToolExecutionMode;
		maxTurnsPerRun?: number;
		stopOnBudgetAction?: AgentLoopStopOnBudgetAction;
		ablation?: {
			disableSteering?: boolean;
			disableFollowUp?: boolean;
			forceSequentialTools?: boolean;
		};
	};
	delegation?: {
		mode?: AgentDelegationMode;
	};
	supervisor?: AgentDefinitionSupervisorPolicyInput;
	hooks?: {
		extensions?: string[];
	};
	dependencies?: AgentDefinitionDependenciesInput;
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
	/** Compiled surface declarations. Empty array = broadcast all events. */
	surfaces: AgentDefinitionSurfaceInput[];
	capabilities: AgentDefinitionCapabilities;
	memory: AgentDefinitionMemory;
	policies: AgentDefinitionPolicies;
	loop?: AgentDefinitionLoopConfig;
	delegation?: AgentDefinitionDelegationConfig;
	supervisor?: AgentDefinitionSupervisorPolicyConfig;
	hooks: AgentDefinitionHooks;
	dependencies?: AgentDefinitionDependenciesConfig;
	resource?: AgentResourceConfig;
	children: ResolvedAgentDefinitionChild[];
}
