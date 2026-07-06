/**
 *
 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
/**
 *
 */
export type ToolExecutionMode = "sequential" | "parallel";
/**
 *
 */
export type AgentCapabilityKind = "tool" | "memory" | "session" | "model" | "supervisor";
/**
 *
 */
export type AgentCapabilityAvailability = "root" | "child" | "shared";
/**
 *
 */
export interface AgentActionMetadata {
	kind: AgentCapabilityKind;
	capability?: string;
	availability?: AgentCapabilityAvailability;
	description?: string;
}
/**
 *
 */
export interface AgentCapabilityDefinition {
	name: string;
	kind: AgentCapabilityKind;
	description?: string;
	availability?: AgentCapabilityAvailability;
	actions: any[];
}

/**
 *
 */
export type AgentRole = "root" | "child";

/**
 *
 */
export interface AgentModelSelector {
	provider: string;
	id: string;
	thinkingLevel?: ThinkingLevel;
}

/**
 * Built-in adapter short names. Used as aliases in agent.yaml — the materializer
 * resolves these to their npm packages via BUILTIN_PACKAGES.
 * Treat as documentation; do NOT validate against this at parse time.
 */
export type AgentAdapterName = string;

/**
 *
 */
export interface AgentDefinitionAdapterCacheInput {
	enabled?: boolean;
	ttlMs?: number;
	maxEntries?: number;
}

/**
 *
 */
export interface AgentDefinitionAdapterCacheConfig {
	enabled: boolean;
	ttlMs: number;
	maxEntries: number;
}

/**
 *
 */
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

/**
 *
 */
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

/**
 *
 */
export type AdapterStability = "stable" | "beta" | "experimental";

/**
 *
 */
export interface AgentDefinitionAdapterInput {
	/**
	 * Built-in alias (e.g. "fs") or npm package name (e.g. "@company/my-adapter").
	 * Mutually exclusive with `path`.
	 */
	name?: string;
	/**
	 * Path to a TypeScript file that exports createAdapter().
	 * Loaded at runtime via jiti — no build step required.
	 * Mutually exclusive with `name`. Relative to the blueprint file.
	 */
	path?: string;
	/** Action subset to mount. Omit for all defaults. */
	actions?: string[];
	/** Shell command patterns to block (regex strings). Passed to adapter-shell's blockedPatterns. */
	blockedPatterns?: string[];
	/** Stability tier. Experimental adapters are excluded from default blueprints. */
	stability?: AdapterStability;
	cache?: AgentDefinitionAdapterCacheInput;
	runtime?: AgentDefinitionLectorRuntimeInput;
}

/**
 *
 */
export interface CompiledAgentAdapterDefinition {
	/**
	 * Adapter name as written in agent.yaml: an npm package specifier, a short
	 * alias (resolved by the materializer), or "_external" for path-loaded adapters.
	 */
	name: string;
	/** Resolved absolute path. Set for path-based adapters (materializer fills this). */
	path?: string;
	/** Action filter passed to the adapter factory. */
	actions: string[];
	toolNames: string[];
	/** Shell command patterns to block (string regexes compiled to RegExp by materializer). */
	blockedPatterns?: string[];
	stability?: AdapterStability;
	cache?: AgentDefinitionAdapterCacheConfig;
	runtime?: AgentDefinitionLectorRuntimeConfig;
}

/**
 *
 */
export interface AgentDefinitionChildReference {
	name: string;
	blueprint: string;
}

/**
 *
 */
export interface AgentDefinitionHooks {
	extensions: string[];
}

/**
 *
 */
export interface AgentDefinitionPolicies {
	appendSystemPrompt: string[];
}

/**
 *
 */
export type AgentLoopStrategy = "default" | "minimal" | "ablation";

/**
 *
 */
export type AgentLoopStopOnBudgetAction = "inform" | "warn" | "throttle" | "abort";

/**
 *
 */
export interface AgentDefinitionLoopAblationConfig {
	disableSteering: boolean;
	disableFollowUp: boolean;
	forceSequentialTools: boolean;
}

/**
 *
 */
export interface AgentDefinitionLoopConfig {
	strategy?: AgentLoopStrategy;
	steeringMode?: "all" | "one-at-a-time";
	followUpMode?: "all" | "one-at-a-time";
	toolExecution?: ToolExecutionMode;
	maxTurnsPerRun?: number;
	stopOnBudgetAction?: AgentLoopStopOnBudgetAction;
	ablation?: AgentDefinitionLoopAblationConfig;
}

/**
 *
 */
export type AgentDelegationMode = "off" | "manual" | "auto";

/**
 *
 */
export interface AgentDefinitionDelegationConfig {
	mode: AgentDelegationMode;
}

/**
 *
 */
export type SupervisorUpgradePolicy = "rebuild_only" | "packages" | "self";

/**
 *
 */
export interface AgentDefinitionSupervisorPolicyInput {
	heartbeatIntervalMs?: number;
	heartbeatTimeoutMs?: number;
	maxMissedHeartbeats?: number;
	smokeTestTimeoutMs?: number;
	handoffTimeoutMs?: number;
	maxFixIterations?: number;
	upgradePolicy?: SupervisorUpgradePolicy;
}

/**
 *
 */
export interface AgentDefinitionSupervisorPolicyConfig {
	heartbeatIntervalMs: number;
	heartbeatTimeoutMs: number;
	maxMissedHeartbeats: number;
	smokeTestTimeoutMs: number;
	handoffTimeoutMs: number;
	maxFixIterations: number;
	upgradePolicy: SupervisorUpgradePolicy;
}

/**
 *
 */
export interface AgentDefinitionCapabilities {
	tools: string[];
	orchestration: boolean;
}

/**
 *
 */
export interface AgentDefinitionMemory {
	session: "memory" | "persistent";
	working: Record<string, unknown>;
}

/**
 *
 */
export interface AgentDefinitionPackageSourceInput {
	source: string;
	extensions?: string[];
	skills?: string[];
	prompts?: string[];
	themes?: string[];
}

/**
 *
 */
export type AgentDefinitionPackageSource = string | AgentDefinitionPackageSourceInput;

/**
 *
 */
export interface AgentDefinitionDependenciesInput {
	packages?: AgentDefinitionPackageSource[];
	extensions?: string[];
	skills?: string[];
	prompts?: string[];
	themes?: string[];
}

/**
 *
 */
export interface AgentDefinitionDependenciesConfig {
	packages: AgentDefinitionPackageSource[];
	extensions: string[];
	skills: string[];
	prompts: string[];
	themes: string[];
}

/**
 *
 */
export interface AgentResourceMetadata {
	name?: string;
	labels: Record<string, string>;
	annotations: Record<string, string>;
}

/**
 *
 */
export interface AgentResourceConfig {
	apiVersion: string;
	kind: string;
	metadata: AgentResourceMetadata;
}

/**
 *
 */
export interface AgentDefinitionSurfaceInput {
	/** Transport type. Currently only 'sse' is supported (via RouterAdapter). */
	type: "sse";
	/**
	 * Event type allowlist. Only command/event events whose type matches one of
	 * these patterns are forwarded to connected clients.
	 *
	 * Patterns support a single trailing wildcard: 'fs.*' matches 'fs.read',
	 * 'fs.write', etc. Use '*' alone to pass all events.
	 *
	 * Omit or set to [] to forward all events (open broadcast).
	 */
	events?: string[];
}

/**
 *
 */
export interface AgentDefinitionInput {
	name: string;
	model?: string | AgentModelSelector;
	systemPrompt?: string;
	adapters?: AgentDefinitionAdapterInput[];
	/** Event surface declarations — controls what the RouterAdapter broadcasts. */
	surfaces?: AgentDefinitionSurfaceInput[];
	capabilities?: {
		tools?: string[];
		orchestration?: boolean;
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

/**
 *
 */
export interface ResolvedAgentDefinitionChild {
	name: string;
	blueprint: string;
}

/**
 *
 */
export interface CompiledAgentDefinition {
	name: string;
	sourcePath?: string;
	baseDir?: string;
	model?: AgentModelSelector;
	systemPrompt?: string;
	adapters: CompiledAgentAdapterDefinition[];
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
