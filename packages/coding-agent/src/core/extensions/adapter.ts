/**
 * ExtensionAdapterSource + buildExtensionAdapter — ISP + DIP applied.
 *
 * PROBLEM:  _bindExtensionCore() in AgentSession was 200 lines of closures
 *           adapting AgentSession's concrete methods to ExtensionActions /
 *           ExtensionContextActions. It lived in AgentSession because there
 *           was no abstraction to depend on — only the concrete class.
 *
 * SOLID FIX:
 *   ISP — ExtensionAdapterSource is exactly what the factory needs.
 *         AgentSession implements it. Nothing extraneous.
 *   DIP — buildExtensionAdapter() depends on the interface, not AgentSession.
 *         Testable with a mock source. Moveable without touching AgentSession.
 *   SRP — Pure factory: builds the adapter objects and returns them.
 *         Calling runner.bindCore() is the caller's responsibility.
 *   OCP — Adding a new extension capability means adding to the interface
 *         and the factory. AgentSession itself does not change.
 *
 * After this:
 *   AgentSession._bindExtensionCore() → 4 lines (build + bindCore call)
 *   ExtensionOrchestrator.boot(source) → calls buildExtensionAdapter(source, runner)
 */

import type { ThinkingLevel } from "@dpopsuev/alef-agent-core";
import type { ImageContent, Model, TextContent } from "@dpopsuev/alef-ai";
import type { ModelRegistry } from "../model-registry.js";
import type { AgentPlatformContext } from "../platform/types.js";
import type { PromptTemplate } from "../prompt-templates.js";
import type { Skill } from "../skills.js";
import type { SlashCommandInfo } from "../slash-commands.js";
import type { ExtensionRunner } from "./runner.js";
import type {
	CompactOptions,
	ContextUsage,
	ExtensionActions,
	ExtensionContextActions,
	ProviderConfig,
	ToolInfo,
} from "./types.js";

// ---------------------------------------------------------------------------
// ExtensionAdapterSource
//
// The minimum surface AgentSession (or any session host) must expose so the
// factory can build ExtensionActions + ExtensionContextActions.
//
// AgentSession satisfies this interface already — see the `implements`
// declaration added to AgentSession after this file is introduced.
// ---------------------------------------------------------------------------

export interface ExtensionAdapterSource {
	// ── Actions group ──────────────────────────────────────────────────────
	/** Queue a custom message (triggers a new agent turn by default). */
	sendCustomMessage<T = unknown>(
		message: { customType: string; content?: unknown; display?: unknown; details?: T },
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): Promise<void>;

	/** Queue a user-role message. */
	sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp" },
	): Promise<void>;

	/** Append a custom entry to the session log. */
	appendSessionEntry<T = unknown>(customType: string, data?: T): void;

	/** Set the session display name. */
	setSessionName(name: string): void;

	/** Get the session display name. */
	getSessionName(): string | undefined;

	/** Attach a label to a session entry. */
	appendLabelChange(entryId: string, label: string | undefined): void;

	/** Names of currently active tools. */
	getActiveToolNames(): string[];

	/** All registered tools with metadata. */
	getAllTools(): ToolInfo[];

	/** Activate a specific set of tools by name. */
	setActiveToolsByName(toolNames: string[]): void;

	/** Rebuild the tool registry (called after extension tool registration changes). */
	refreshToolRegistry(): void;

	/** Prompt templates for getCommands() command list. */
	readonly promptTemplates: ReadonlyArray<PromptTemplate>;

	/** Skills loaded by the resource loader (for getCommands() skill list). */
	readonly skills: ReadonlyArray<Skill>;

	/** Set the active model. Returns false when the model has no configured auth. */
	setModel(model: Model<any>): Promise<void>;

	/** Current thinking level. */
	readonly thinkingLevel: ThinkingLevel;

	/** Set the thinking level. */
	setThinkingLevel(level: ThinkingLevel): void;

	// ── Context group ──────────────────────────────────────────────────────
	/** Currently selected model. */
	readonly model: Model<any> | undefined;

	/** Platform context (action registry, organs, etc.). */
	readonly platform: AgentPlatformContext;

	/** Whether the agent is currently streaming a response. */
	readonly isStreaming: boolean;

	/** AbortSignal of the currently running agent call. */
	readonly agentSignal: AbortSignal | undefined;

	/** Whether there are queued messages waiting to be delivered. */
	readonly pendingMessageCount: number;

	/** Execute the registered shutdown handler (from extension bindings). */
	executeShutdown(): void;

	/** Current context usage stats. */
	getContextUsage(): ContextUsage | undefined;

	/** Fire-and-forget compaction with optional result/error callbacks. */
	triggerCompact(options?: CompactOptions): void;

	/** Current effective system prompt. */
	readonly systemPrompt: string;

	/** Abort the current agent operation. */
	abort(): Promise<void>;

	// ── Provider group ─────────────────────────────────────────────────────
	/** Model registry for provider registration/unregistration. */
	readonly modelRegistry: ModelRegistry;

	/** Refresh the active model from the registry (after provider changes). */
	refreshCurrentModelFromRegistry(): void;
}

// ---------------------------------------------------------------------------
// buildExtensionAdapter
//
// Pure factory — no side effects, no state, fully testable with a mock source.
// The closures that were previously in AgentSession._bindExtensionCore() live
// here. They adapt ExtensionAdapterSource to ExtensionActions + ExtensionContextActions.
// ---------------------------------------------------------------------------

export function buildExtensionAdapter(
	source: ExtensionAdapterSource,
	runner: ExtensionRunner,
): {
	actions: ExtensionActions;
	contextActions: ExtensionContextActions;
	providerActions: {
		registerProvider: (name: string, config: ProviderConfig) => void;
		unregisterProvider: (name: string) => void;
	};
} {
	// ── getCommands: assembles slash commands from three sources ──────────
	const getCommands = (): SlashCommandInfo[] => {
		const extensionCommands: SlashCommandInfo[] = runner.getRegisteredCommands().map((command) => ({
			name: command.invocationName,
			description: command.description,
			source: "extension",
			sourceInfo: command.sourceInfo,
		}));

		const templates: SlashCommandInfo[] = source.promptTemplates.map((template) => ({
			name: template.name,
			description: template.description,
			source: "prompt",
			sourceInfo: template.sourceInfo,
		}));

		const skills: SlashCommandInfo[] = source.skills.map((skill) => ({
			name: `skill:${skill.name}`,
			description: skill.description,
			source: "skill",
			sourceInfo: skill.sourceInfo,
		}));

		return [...extensionCommands, ...templates, ...skills];
	};

	// ── actions: what extensions can DO to the session ───────────────────
	const actions: ExtensionActions = {
		sendMessage: (message, options) => {
			source.sendCustomMessage(message, options).catch((err) => {
				runner.emitError({
					extensionPath: "<runtime>",
					event: "send_message",
					error: err instanceof Error ? err.message : String(err),
				});
			});
		},
		sendUserMessage: (content, options) => {
			source.sendUserMessage(content, options).catch((err) => {
				runner.emitError({
					extensionPath: "<runtime>",
					event: "send_user_message",
					error: err instanceof Error ? err.message : String(err),
				});
			});
		},
		appendEntry: (customType, data) => source.appendSessionEntry(customType, data),
		setSessionName: (name) => source.setSessionName(name),
		getSessionName: () => source.getSessionName(),
		setLabel: (entryId, label) => source.appendLabelChange(entryId, label),
		getActiveTools: () => source.getActiveToolNames(),
		getAllTools: () => source.getAllTools(),
		setActiveTools: (toolNames) => source.setActiveToolsByName(toolNames),
		refreshTools: () => source.refreshToolRegistry(),
		getCommands,
		setModel: async (model) => {
			if (!source.modelRegistry.hasConfiguredAuth(model)) return false;
			await source.setModel(model);
			return true;
		},
		getThinkingLevel: () => source.thinkingLevel,
		setThinkingLevel: (level) => source.setThinkingLevel(level),
	};

	// ── contextActions: what extensions can READ from the session ─────────
	const contextActions: ExtensionContextActions = {
		getModel: () => source.model,
		getPlatformContext: () => source.platform,
		isIdle: () => !source.isStreaming,
		getSignal: () => source.agentSignal,
		abort: () => {
			void source.abort();
		},
		hasPendingMessages: () => source.pendingMessageCount > 0,
		shutdown: () => source.executeShutdown(),
		getContextUsage: () => source.getContextUsage(),
		compact: (options) => source.triggerCompact(options),
		getSystemPrompt: () => source.systemPrompt,
	};

	// ── providerActions: model provider registration ──────────────────────
	const providerActions = {
		registerProvider: (name: string, config: ProviderConfig) => {
			source.modelRegistry.registerProvider(name, config);
			source.refreshCurrentModelFromRegistry();
		},
		unregisterProvider: (name: string) => {
			source.modelRegistry.unregisterProvider(name);
			source.refreshCurrentModelFromRegistry();
		},
	};

	return { actions, contextActions, providerActions };
}
