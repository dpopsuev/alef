/**
 * CompactionService — owns all compaction lifecycle state and logic.
 *
 * Extracted from AgentSession. AgentSession delegates compact(), abortCompaction(),
 * _checkCompaction() (called from event handler), and the isCompacting getter here.
 *
 * The service receives a narrow capabilities object created inline in AgentSession
 * so the dependency arrow points inward.
 */

import type { Agent, ThinkingLevel } from "@dpopsuev/alef-agent-core";
import type { AssistantMessage, Model } from "@dpopsuev/alef-ai";
import { isContextOverflow } from "@dpopsuev/alef-ai";
import type { AgentSessionEvent } from "../agent-session.js";
import { formatNoModelSelectedMessage } from "../auth-guidance.js";
import type { ExtensionRunner } from "../extensions/runner.js";
import type { SessionBeforeCompactResult } from "../extensions/types.js";
import { getLatestCompactionEntry, type SessionManager } from "../session-manager.js";
import type { SettingsManager } from "../settings-manager.js";
import {
	type CompactionResult,
	calculateContextTokens,
	compact,
	estimateContextTokens,
	prepareCompaction,
	shouldCompact,
} from "./index.js";

// ---------------------------------------------------------------------------
// Capabilities — what CompactionService needs from AgentSession
// ---------------------------------------------------------------------------

export interface CompactionSessionCapabilities {
	getModel(): Model<any> | undefined;
	getThinkingLevel(): ThinkingLevel;
	getRequiredRequestAuth(model: Model<any>): Promise<{ apiKey: string; headers: Record<string, string> }>;
	getAgent(): Agent;
	getExtensionRunner(): ExtensionRunner;
	emitEvent(event: AgentSessionEvent): void;
	disconnect(): void;
	reconnect(): void;
	abort(): Promise<void>;
}

// ---------------------------------------------------------------------------
// CompactionService
// ---------------------------------------------------------------------------

export class CompactionService {
	private _compactionAbortController?: AbortController;
	private _autoCompactionAbortController?: AbortController;
	private _branchSummaryAbortController?: AbortController;
	private _overflowRecoveryAttempted = false;

	constructor(
		private readonly sessionManager: SessionManager,
		private readonly settingsManager: SettingsManager,
		private readonly caps: CompactionSessionCapabilities,
	) {}

	get isCompacting(): boolean {
		return (
			this._autoCompactionAbortController !== undefined ||
			this._compactionAbortController !== undefined ||
			this._branchSummaryAbortController !== undefined
		);
	}

	// -------------------------------------------------------------------------
	// Manual compact (public API)
	// -------------------------------------------------------------------------

	async runManual(customInstructions?: string): Promise<CompactionResult> {
		this.caps.disconnect();
		await this.caps.abort();
		this._compactionAbortController = new AbortController();
		this.caps.emitEvent({ type: "compaction_start", reason: "manual" });

		try {
			const model = this.caps.getModel();
			if (!model) {
				throw new Error(formatNoModelSelectedMessage());
			}

			const { apiKey, headers } = await this.caps.getRequiredRequestAuth(model);

			const pathEntries = this.sessionManager.getBranch();
			const settings = this.settingsManager.getCompactionSettings();

			const preparation = prepareCompaction(pathEntries, settings);
			if (!preparation) {
				const lastEntry = pathEntries[pathEntries.length - 1];
				if (lastEntry?.type === "compaction") {
					throw new Error("Already compacted");
				}
				throw new Error("Nothing to compact (session too small)");
			}

			let extensionCompaction: CompactionResult | undefined;
			let fromExtension = false;

			const runner = this.caps.getExtensionRunner();
			if (runner.hasHandlers("session_before_compact")) {
				const result = (await runner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions,
					signal: this._compactionAbortController.signal,
				})) as SessionBeforeCompactResult | undefined;

				if (result?.cancel) {
					throw new Error("Compaction cancelled");
				}

				if (result?.compaction) {
					extensionCompaction = result.compaction;
					fromExtension = true;
				}
			}

			let summary: string;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let details: unknown;

			if (extensionCompaction) {
				summary = extensionCompaction.summary;
				firstKeptEntryId = extensionCompaction.firstKeptEntryId;
				tokensBefore = extensionCompaction.tokensBefore;
				details = extensionCompaction.details;
			} else {
				const result = await compact(
					preparation,
					model,
					apiKey,
					headers,
					customInstructions,
					this._compactionAbortController.signal,
					this.caps.getThinkingLevel(),
				);
				summary = result.summary;
				firstKeptEntryId = result.firstKeptEntryId;
				tokensBefore = result.tokensBefore;
				details = result.details;
			}

			if (this._compactionAbortController.signal.aborted) {
				throw new Error("Compaction cancelled");
			}

			this.sessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromExtension);
			const newEntries = this.sessionManager.getEntries();
			const sessionContext = this.sessionManager.buildSessionContext();
			const agent = this.caps.getAgent();
			agent.state.messages = sessionContext.messages;

			const savedCompactionEntry = newEntries.find((e) => e.type === "compaction" && e.summary === summary) as
				| Extract<(typeof newEntries)[number], { type: "compaction" }>
				| undefined;

			if (runner && savedCompactionEntry) {
				await runner.emit({ type: "session_compact", compactionEntry: savedCompactionEntry, fromExtension });
			}

			const compactionResult = {
				summary,
				firstKeptEntryId,
				tokensBefore,
				details,
			};

			this.caps.emitEvent({
				type: "compaction_end",
				reason: "manual",
				result: compactionResult,
				aborted: false,
				willRetry: false,
			});

			return compactionResult;
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "compaction failed";
			this.caps.emitEvent({
				type: "compaction_end",
				reason: "manual",
				result: undefined,
				aborted: this._compactionAbortController?.signal.aborted ?? false,
				willRetry: false,
				errorMessage,
			});
			throw error;
		} finally {
			this._compactionAbortController = undefined;
			this.caps.reconnect();
		}
	}

	// -------------------------------------------------------------------------
	// Auto-compaction check (called from event handler after each turn)
	// -------------------------------------------------------------------------

	async checkAfterTurn(assistantMessage: AssistantMessage, skipAbortedCheck = true): Promise<void> {
		const settings = this.settingsManager.getCompactionSettings();
		if (!settings.enabled) return;

		if (skipAbortedCheck && assistantMessage.stopReason === "aborted") return;

		const model = this.caps.getModel();
		const contextWindow = model?.contextWindow ?? 0;

		const sameModel = model && assistantMessage.provider === model.provider && assistantMessage.model === model.id;

		const compactionEntry = getLatestCompactionEntry(this.sessionManager.getBranch());
		const assistantIsFromBeforeCompaction =
			compactionEntry !== null && assistantMessage.timestamp <= new Date(compactionEntry.timestamp).getTime();
		if (assistantIsFromBeforeCompaction) {
			return;
		}

		// Case 1: Overflow
		if (sameModel && isContextOverflow(assistantMessage, contextWindow)) {
			if (this._overflowRecoveryAttempted) {
				this.caps.emitEvent({
					type: "compaction_end",
					reason: "overflow",
					result: undefined,
					aborted: false,
					willRetry: false,
					errorMessage:
						"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
				});
				return;
			}

			this._overflowRecoveryAttempted = true;
			const agent = this.caps.getAgent();
			const messages = agent.state.messages;
			if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
				agent.state.messages = messages.slice(0, -1);
			}
			await this._runAuto("overflow", true);
			return;
		}

		// Case 2: Threshold
		let contextTokens: number;
		if (assistantMessage.stopReason === "error") {
			const messages = this.caps.getAgent().state.messages;
			const estimate = estimateContextTokens(messages);
			if (estimate.lastUsageIndex === null) return;
			const usageMsg = messages[estimate.lastUsageIndex];
			if (
				compactionEntry &&
				usageMsg.role === "assistant" &&
				(usageMsg as AssistantMessage).timestamp <= new Date(compactionEntry.timestamp).getTime()
			) {
				return;
			}
			contextTokens = estimate.tokens;
		} else {
			contextTokens = calculateContextTokens(assistantMessage.usage);
		}

		if (contextWindow > 0 && shouldCompact(contextTokens, contextWindow, settings)) {
			if (!this._autoCompactionAbortController) {
				await this._runAuto("threshold", false);
			}
		}
	}

	// -------------------------------------------------------------------------
	// Internal auto-compaction execution
	// -------------------------------------------------------------------------

	private async _runAuto(reason: "overflow" | "threshold", willRetry: boolean): Promise<void> {
		const settings = this.settingsManager.getCompactionSettings();
		this.caps.emitEvent({ type: "compaction_start", reason });
		this._autoCompactionAbortController = new AbortController();

		try {
			const model = this.caps.getModel();
			if (!model) {
				this.caps.emitEvent({
					type: "compaction_end",
					reason,
					result: undefined,
					aborted: false,
					willRetry: false,
				});
				return;
			}

			let apiKey: string;
			let headers: Record<string, string>;
			try {
				const auth = await this.caps.getRequiredRequestAuth(model);
				apiKey = auth.apiKey;
				headers = auth.headers;
			} catch {
				this.caps.emitEvent({
					type: "compaction_end",
					reason,
					result: undefined,
					aborted: false,
					willRetry: false,
				});
				return;
			}

			const pathEntries = this.sessionManager.getBranch();
			const preparation = prepareCompaction(pathEntries, settings);
			if (!preparation) {
				this.caps.emitEvent({
					type: "compaction_end",
					reason,
					result: undefined,
					aborted: false,
					willRetry: false,
				});
				return;
			}

			let extensionCompaction: CompactionResult | undefined;
			let fromExtension = false;

			const runner = this.caps.getExtensionRunner();
			if (runner.hasHandlers("session_before_compact")) {
				const extensionResult = (await runner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions: undefined,
					signal: this._autoCompactionAbortController.signal,
				})) as SessionBeforeCompactResult | undefined;

				if (extensionResult?.cancel) {
					this.caps.emitEvent({
						type: "compaction_end",
						reason,
						result: undefined,
						aborted: true,
						willRetry: false,
					});
					return;
				}

				if (extensionResult?.compaction) {
					extensionCompaction = extensionResult.compaction;
					fromExtension = true;
				}
			}

			let summary: string;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let details: unknown;

			if (extensionCompaction) {
				summary = extensionCompaction.summary;
				firstKeptEntryId = extensionCompaction.firstKeptEntryId;
				tokensBefore = extensionCompaction.tokensBefore;
				details = extensionCompaction.details;
			} else {
				const compactResult = await compact(
					preparation,
					model,
					apiKey,
					headers,
					undefined,
					this._autoCompactionAbortController.signal,
					this.caps.getThinkingLevel(),
				);
				summary = compactResult.summary;
				firstKeptEntryId = compactResult.firstKeptEntryId;
				tokensBefore = compactResult.tokensBefore;
				details = compactResult.details;
			}

			if (this._autoCompactionAbortController.signal.aborted) {
				this.caps.emitEvent({ type: "compaction_end", reason, result: undefined, aborted: true, willRetry: false });
				return;
			}

			this.sessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromExtension);
			const newEntries = this.sessionManager.getEntries();
			const sessionContext = this.sessionManager.buildSessionContext();
			const agent = this.caps.getAgent();
			agent.state.messages = sessionContext.messages;

			const savedCompactionEntry = newEntries.find((e) => e.type === "compaction" && e.summary === summary) as
				| Extract<(typeof newEntries)[number], { type: "compaction" }>
				| undefined;

			if (savedCompactionEntry) {
				await runner.emit({ type: "session_compact", compactionEntry: savedCompactionEntry, fromExtension });
			}

			const compactionResult = { summary, firstKeptEntryId, tokensBefore, details };
			this.caps.emitEvent({ type: "compaction_end", reason, result: compactionResult, aborted: false, willRetry });

			this._overflowRecoveryAttempted = false;

			if (willRetry) {
				const messages = agent.state.messages;
				if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
					agent.state.messages = messages.slice(0, -1);
				}
				setTimeout(() => {
					agent.continue().catch(() => {});
				}, 100);
			} else if (agent.hasQueuedMessages()) {
				setTimeout(() => {
					agent.continue().catch(() => {});
				}, 100);
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "compaction failed";
			this.caps.emitEvent({
				type: "compaction_end",
				reason,
				result: undefined,
				aborted: false,
				willRetry: false,
				errorMessage:
					reason === "overflow"
						? `Context overflow recovery failed: ${errorMessage}`
						: `Auto-compaction failed: ${errorMessage}`,
			});
		} finally {
			this._autoCompactionAbortController = undefined;
		}
	}

	// -------------------------------------------------------------------------
	// Abort controls
	// -------------------------------------------------------------------------

	abortManual(): void {
		this._compactionAbortController?.abort();
		this._autoCompactionAbortController?.abort();
	}

	abortBranchSummary(): void {
		this._branchSummaryAbortController?.abort();
	}

	// -------------------------------------------------------------------------
	// Settings delegation
	// -------------------------------------------------------------------------

	setAutoEnabled(enabled: boolean): void {
		this.settingsManager.setCompactionEnabled(enabled);
	}

	get autoEnabled(): boolean {
		return this.settingsManager.getCompactionEnabled();
	}
}
