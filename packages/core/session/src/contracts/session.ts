import type { ImageContent, TextContent } from "@dpopsuev/alef-kernel/content";

// ---------------------------------------------------------------------------
// AgentEvent — typed output from the agent to any observer.
// Types are owned here; they are structurally identical to reasoner types
// but session.ts must not depend on adapter packages.
// ---------------------------------------------------------------------------

/**
 *
 */
export interface ToolStarted {
	callId: string;
	name: string;
	args: Record<string, unknown>;
}

/**
 *
 */
export interface ToolEnded {
	callId: string;
	elapsedMs: number;
	ok: boolean;
	display?: string;
	displayKind?: string;
}

/**
 *
 */
export interface TokensConsumed {
	input: number;
	output: number;
	totalTokens: number;
	costUsd?: number;
}

/**
 *
 */
export type AgentEvent =
	| { type: "chunk"; text: string }
	| { type: "thinking"; text: string }
	| { type: "tool-start"; callId: string; name: string; args: Record<string, unknown> }
	| { type: "tool-end"; callId: string; elapsedMs: number; ok: boolean; display?: string; displayKind?: string }
	| { type: "tool-chunk"; callId: string; text: string }
	| { type: "tool-validation-error"; callId: string; field: string; message: string }
	| { type: "tool-stall"; callId: string; name: string; elapsedMs: number; lastChunkMs: number }
	| { type: "turn-complete"; reply: string }
	| { type: "turn-error"; message: string }
	| { type: "token-usage"; usage: TokensConsumed }
	| { type: "message-queued"; queueLength: number; text?: string; mode?: "steer" | "followUp" | "nextTurn" }
	| { type: "subagent-identity"; callId: string; color: string; address: string; modelId?: string }
	| { type: "subagent-token-usage"; callId: string; input: number; output: number }
	| { type: "inner-tool-start"; parentCallId: string; callId: string; name: string; args: Record<string, unknown> }
	| { type: "inner-tool-end"; parentCallId: string; callId: string }
	| { type: "inner-chunk"; parentCallId: string; text: string }
	| { type: "workflow-step"; workflowId: string; eventType: string; step: string; status: string; score?: number }
	| { type: "workflow-completed"; workflowId: string; elapsedMs: number }
	| { type: "workflow-error"; workflowId: string; step: string; error: string }
	| { type: "workflow-escalated"; workflowId: string; rule: string; retries?: number; score?: number }
	| { type: "task-progress"; taskId: string; chunk: string }
	| { type: "task-completed"; taskId: string; profile: string; reply: string; elapsedMs: number }
	| { type: "task-failed"; taskId: string; profile: string; error: string; elapsedMs: number }
	| { type: "adapter-signal"; signalType: string; payload: Record<string, unknown> }
	| { type: "state-changed"; modelId: string; thinking: string; contextWindow: number };

// ---------------------------------------------------------------------------
// DirectiveView — the minimal surface Session exposes from the directive system.
// Callers never see DirectiveAdapter from adapter-alef.
// ---------------------------------------------------------------------------

/**
 *
 */
export interface DirectiveView {
	list(): ReadonlyArray<{ id: string; priority: number; enabled: boolean; tags?: string[]; contentPreview?: string }>;
	enable(id: string): void;
	disable(id: string): void;
	toggle(id: string): void;
	replace(id: string, content: string): void;
	add(id: string, priority: number, content: string, tags?: string[]): void;
	remove(id: string): void;
}

// ---------------------------------------------------------------------------
// SessionState — stable identity, serialisable, survives attach/detach
// ---------------------------------------------------------------------------

/**
 *
 */
export interface SessionState {
	readonly id: string;
	modelId: string;
	contextWindow: number;
}

// ---------------------------------------------------------------------------
// AdapterManagementSession — optional capability port for hot adapter ops
// ---------------------------------------------------------------------------

/**
 * Capability surface for loading, unloading, and reloading adapters at runtime.
 * Sessions that do not support adapter management omit this port entirely.
 */
export interface AdapterManagementSession {
	loadAdapter(path: string): Promise<void>;
	unloadAdapter(name: string): boolean;
	reloadAdapter(name: string, path: string): Promise<void>;
	readonly adapters: ReadonlyArray<{ name: string; description?: string }>;
}

// ---------------------------------------------------------------------------
// Session — Strategy interface
// ---------------------------------------------------------------------------

/**
 *
 */
export interface Session extends Partial<AdapterManagementSession> {
	readonly state: SessionState;

	getModel(): string;
	setModel(id: string): void;
	getThinking(): string;
	setThinking(level: string): void;

	setTurnController(ctrl: AbortController | undefined): void;

	dispose(): void | Promise<void>;

	send?(content: string | (TextContent | ImageContent)[], timeoutMs?: number): Promise<string>;
	receive?(
		content: string | (TextContent | ImageContent)[],
		opts?: { delivery?: "steer" | "followUp" | "nextTurn" },
	): void;

	getDirective?(): DirectiveView | undefined;

	subscribe(observer: (event: AgentEvent) => void): () => void;

	cancelToolCall?(callId: string, toolName: string): void;

	/**
	 * LLM-backed summarizer for manual :compact / durable compaction.
	 * Required for interactive compaction; tests may inject a fake.
	 */
	summarizeForCompaction?(
		messages: readonly unknown[],
		opts?: { instructions?: string; priorSummary?: string },
	): Promise<string> | string;
}
