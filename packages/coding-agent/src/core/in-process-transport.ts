/**
 * InProcessTransport — wraps AgentSession as an AgentTransport.
 *
 * Pure delegation. Every call forwards directly to AgentSession.
 * No serialization, no IPC, no overhead.
 */

import type { Agent, ThinkingLevel } from "@dpopsuev/alef-agent-core";
import type { Model } from "@dpopsuev/alef-ai";
import type {
	AgentSession,
	AgentSessionEventListener,
	ModelCycleResult,
	PromptOptions,
	SessionStats,
} from "./agent-session.js";
import type { AgentTransport, TransportExtensionBindings } from "./agent-transport.js";
import type { BashResult } from "./bash-executor.js";
import type { CompactionResult } from "./compaction/index.js";
import type { ContextUsage, ToolDefinition } from "./extensions/index.js";
import type { ExtensionRunner } from "./extensions/runner.js";
import type { ModelRegistry } from "./model-registry.js";
import type { PromptTemplate } from "./prompt-templates.js";
import type { ResourceLoader } from "./resource-loader.js";
import type { SessionManager } from "./session-manager.js";
import type { SettingsManager } from "./settings-manager.js";

export class InProcessTransport implements AgentTransport {
	constructor(private _session: AgentSession) {}

	/** Replace the underlying session (used after session replacement flows) */
	setSession(session: AgentSession): void {
		this._session = session;
	}

	// -- Prompting ---------------------------------------------------------

	async prompt(text: string, options?: PromptOptions): Promise<void> {
		await this._session.prompt(text, options);
	}

	async steer(text: string): Promise<void> {
		await this._session.steer(text);
	}

	async followUp(text: string): Promise<void> {
		await this._session.followUp(text);
	}

	abort(): void {
		this._session.abort();
	}

	// -- Events ------------------------------------------------------------

	subscribe(listener: AgentSessionEventListener): () => void {
		return this._session.subscribe(listener);
	}

	// -- State -------------------------------------------------------------

	get isStreaming() {
		return this._session.isStreaming;
	}
	get isCompacting() {
		return this._session.isCompacting;
	}
	get isBashRunning() {
		return this._session.isBashRunning;
	}
	get isRetrying() {
		return this._session.isRetrying;
	}
	get retryAttempt() {
		return this._session.retryAttempt;
	}
	get pendingMessageCount() {
		return this._session.pendingMessageCount;
	}
	get model() {
		return this._session.model;
	}
	get thinkingLevel() {
		return this._session.thinkingLevel;
	}
	get systemPrompt() {
		return this._session.systemPrompt;
	}
	get steeringMode() {
		return this._session.steeringMode;
	}
	get followUpMode() {
		return this._session.followUpMode;
	}
	get autoCompactionEnabled() {
		return this._session.autoCompactionEnabled;
	}
	get autoRetryEnabled() {
		return this._session.autoRetryEnabled;
	}
	get state() {
		return this._session.state;
	}
	get messages() {
		return this._session.messages;
	}

	// -- Model -------------------------------------------------------------

	get modelRegistry(): ModelRegistry {
		return this._session.modelRegistry;
	}
	get scopedModels() {
		return this._session.scopedModels;
	}

	async setModel(model: Model<any>): Promise<void> {
		return this._session.setModel(model);
	}

	async cycleModel(direction?: "forward" | "backward"): Promise<ModelCycleResult | undefined> {
		return this._session.cycleModel(direction);
	}

	setScopedModels(models: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>): void {
		this._session.setScopedModels(models);
	}

	// -- Thinking ----------------------------------------------------------

	setThinkingLevel(level: ThinkingLevel): void {
		this._session.setThinkingLevel(level);
	}

	cycleThinkingLevel(): ThinkingLevel | undefined {
		return this._session.cycleThinkingLevel();
	}

	getAvailableThinkingLevels(): ThinkingLevel[] {
		return this._session.getAvailableThinkingLevels();
	}

	// -- Queue -------------------------------------------------------------

	getSteeringMessages() {
		return this._session.getSteeringMessages();
	}

	getFollowUpMessages() {
		return this._session.getFollowUpMessages();
	}

	clearQueue() {
		return this._session.clearQueue();
	}

	// -- Compaction --------------------------------------------------------

	async compact(customInstructions?: string): Promise<CompactionResult> {
		return this._session.compact(customInstructions);
	}

	abortCompaction(): void {
		this._session.abortCompaction();
	}

	abortBranchSummary(): void {
		this._session.abortBranchSummary();
	}

	setAutoCompactionEnabled(enabled: boolean): void {
		this._session.setAutoCompactionEnabled(enabled);
	}

	// -- Retry -------------------------------------------------------------

	abortRetry(): void {
		this._session.abortRetry();
	}

	setAutoRetryEnabled(enabled: boolean): void {
		this._session.setAutoRetryEnabled(enabled);
	}

	// -- Bash --------------------------------------------------------------

	async executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean; operations?: unknown },
	): Promise<BashResult> {
		return this._session.executeBash(command, onChunk, options as any);
	}

	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
		this._session.recordBashResult(command, result, options);
	}

	abortBash(): void {
		this._session.abortBash();
	}

	// -- Session -----------------------------------------------------------

	get sessionManager(): SessionManager {
		return this._session.sessionManager;
	}
	get settingsManager(): SettingsManager {
		return this._session.settingsManager;
	}

	setSessionName(name: string): void {
		this._session.setSessionName(name);
	}

	getSessionStats(): SessionStats {
		return this._session.getSessionStats();
	}

	getContextUsage(): ContextUsage | undefined {
		return this._session.getContextUsage();
	}

	getLastAssistantText(): string | undefined {
		return this._session.getLastAssistantText();
	}

	getUserMessagesForForking(): Array<{ entryId: string; text: string }> {
		return this._session.getUserMessagesForForking();
	}

	async navigateTree(
		targetId: string,
		options?: {
			summarize?: boolean;
			customInstructions?: string;
			replaceInstructions?: boolean;
			label?: string;
		},
	): Promise<any> {
		return this._session.navigateTree(targetId, options);
	}

	// -- Queue modes -------------------------------------------------------

	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this._session.setSteeringMode(mode);
	}

	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this._session.setFollowUpMode(mode);
	}

	// -- Export -------------------------------------------------------------

	async exportToHtml(outputPath?: string): Promise<string> {
		return this._session.exportToHtml(outputPath);
	}

	exportToJsonl(outputPath?: string): string {
		return this._session.exportToJsonl(outputPath);
	}

	// -- Tools -------------------------------------------------------------

	getToolDefinition(name: string): ToolDefinition | undefined {
		return this._session.getToolDefinition(name);
	}

	// -- Extensions --------------------------------------------------------

	get extensionRunner(): ExtensionRunner {
		return this._session.extensionRunner;
	}

	get resourceLoader(): ResourceLoader {
		return this._session.resourceLoader;
	}

	get promptTemplates(): ReadonlyArray<PromptTemplate> {
		return this._session.promptTemplates;
	}

	async bindExtensions(bindings: TransportExtensionBindings): Promise<void> {
		await this._session.bindExtensions(bindings);
	}

	async reload(): Promise<void> {
		await this._session.reload();
	}

	// -- Agent access ------------------------------------------------------

	get agent(): Agent {
		return this._session.agent;
	}

	// -- Lifecycle ---------------------------------------------------------

	dispose(): void {
		this._session.dispose();
	}
}
