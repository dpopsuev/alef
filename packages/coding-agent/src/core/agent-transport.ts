/**
 * AgentTransport — abstract boundary between the TUI and the agent backend.
 *
 * InteractiveMode calls this interface instead of AgentSession directly.
 * Two implementations:
 *   - InProcessTransport: wraps AgentSession (current behavior, zero overhead)
 *   - RpcTransport: wraps RpcClient (child process via JSONL) [future]
 *
 * The types here match AgentSession's actual public API exactly.
 * When RpcTransport is built, it will adapt RPC wire types to these.
 */

import type { Agent, AgentState, ThinkingLevel } from "@dpopsuev/alef-agent-core";
import type { Model } from "@dpopsuev/alef-ai";
import type {
	AgentSessionEvent,
	AgentSessionEventListener,
	ModelCycleResult,
	PromptOptions,
	SessionStats,
} from "./agent-session.js";
import type { BashResult } from "./bash-executor.js";
import type { CompactionResult } from "./compaction/index.js";
import type {
	ContextUsage,
	ExtensionCommandContextActions,
	ExtensionErrorListener,
	ExtensionUIContext,
	ShutdownHandler,
	ToolDefinition,
} from "./extensions/index.js";
import type { ExtensionRunner } from "./extensions/runner.js";
import type { ModelRegistry } from "./model-registry.js";
import type { PromptTemplate } from "./prompt-templates.js";
import type { ResourceLoader } from "./resource-loader.js";
import type { SessionManager } from "./session-manager.js";
import type { SettingsManager } from "./settings-manager.js";

// Re-export types that consumers need
export type { AgentSessionEvent, AgentSessionEventListener, ModelCycleResult, PromptOptions, SessionStats };

// ---------------------------------------------------------------------------
// Extension bindings
// ---------------------------------------------------------------------------

export interface TransportExtensionBindings {
	uiContext?: ExtensionUIContext;
	commandContextActions?: ExtensionCommandContextActions;
	shutdownHandler?: ShutdownHandler;
	onError?: ExtensionErrorListener;
}

// ---------------------------------------------------------------------------
// AgentTransport interface
//
// Mirrors AgentSession's public surface as used by InteractiveMode.
// Every property and method signature matches AgentSession exactly.
// ---------------------------------------------------------------------------

export interface AgentTransport {
	// Prompting
	prompt(text: string, options?: PromptOptions): Promise<void>;
	steer(text: string): Promise<void>;
	followUp(text: string): Promise<void>;
	abort(): void;

	// Events
	subscribe(listener: AgentSessionEventListener): () => void;

	// State
	readonly isStreaming: boolean;
	readonly isCompacting: boolean;
	readonly isBashRunning: boolean;
	readonly isRetrying: boolean;
	readonly retryAttempt: number;
	readonly pendingMessageCount: number;
	readonly model: Model<any> | undefined;
	readonly thinkingLevel: ThinkingLevel;
	readonly systemPrompt: string;
	readonly steeringMode: "all" | "one-at-a-time";
	readonly followUpMode: "all" | "one-at-a-time";
	readonly autoCompactionEnabled: boolean;
	readonly autoRetryEnabled: boolean;
	readonly state: AgentState;
	readonly messages: readonly any[];

	// Model
	readonly modelRegistry: ModelRegistry;
	readonly scopedModels: ReadonlyArray<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	setModel(model: Model<any>): Promise<void>;
	cycleModel(direction?: "forward" | "backward"): Promise<ModelCycleResult | undefined>;
	setScopedModels(models: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>): void;

	// Thinking
	setThinkingLevel(level: ThinkingLevel): void;
	cycleThinkingLevel(): ThinkingLevel | undefined;
	getAvailableThinkingLevels(): ThinkingLevel[];

	// Queue
	getSteeringMessages(): readonly string[];
	getFollowUpMessages(): readonly string[];
	clearQueue(): { steering: string[]; followUp: string[] };

	// Compaction
	compact(customInstructions?: string): Promise<CompactionResult>;
	abortCompaction(): void;
	abortBranchSummary(): void;
	setAutoCompactionEnabled(enabled: boolean): void;

	// Retry
	abortRetry(): void;
	setAutoRetryEnabled(enabled: boolean): void;

	// Bash
	executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean; operations?: unknown },
	): Promise<BashResult>;
	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void;
	abortBash(): void;

	// Session
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;
	setSessionName(name: string): void;
	getSessionStats(): SessionStats;
	getContextUsage(): ContextUsage | undefined;
	getLastAssistantText(): string | undefined;
	getUserMessagesForForking(): Array<{ entryId: string; text: string }>;
	navigateTree(
		targetId: string,
		options?: {
			summarize?: boolean;
			customInstructions?: string;
			replaceInstructions?: boolean;
			label?: string;
		},
	): Promise<any>;

	// Queue modes
	setSteeringMode(mode: "all" | "one-at-a-time"): void;
	setFollowUpMode(mode: "all" | "one-at-a-time"): void;

	// Export
	exportToHtml(outputPath?: string): Promise<string>;
	exportToJsonl(outputPath?: string): string;

	// Tools
	getToolDefinition(name: string): ToolDefinition | undefined;

	// Extensions (in-process specifics — RPC will handle differently)
	readonly extensionRunner: ExtensionRunner;
	readonly resourceLoader: ResourceLoader;
	readonly promptTemplates: ReadonlyArray<PromptTemplate>;
	bindExtensions(bindings: TransportExtensionBindings): Promise<void>;
	reload(): Promise<void>;

	// Agent access
	readonly agent: Agent;

	// Lifecycle
	dispose(): void | Promise<void>;
}
