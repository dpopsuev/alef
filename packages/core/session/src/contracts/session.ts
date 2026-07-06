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
	| { type: "message-queued"; queueLength: number }
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
	list(): ReadonlyArray<{ id: string; priority: number; enabled: boolean; tags?: string[] }>;
	enable(id: string): void;
	disable(id: string): void;
	toggle(id: string): void;
}

// ---------------------------------------------------------------------------
// SessionState — stable identity, serialisable, survives attach/detach
// ---------------------------------------------------------------------------

/**
 *
 */
export interface SessionState {
	readonly id: string;
	readonly modelId: string;
	readonly contextWindow: number;
}

// ---------------------------------------------------------------------------
// Session — Strategy interface
// ---------------------------------------------------------------------------

/**
 *
 */
export interface Session {
	readonly state: SessionState;

	getModel(): string;
	setModel(id: string): void;
	getThinking(): string;
	setThinking(level: string): void;

	setTurnController(ctrl: AbortController | undefined): void;

	loadAdapter?(path: string): Promise<void>;
	unloadAdapter?(name: string): boolean;
	reloadAdapter?(name: string, path: string): Promise<void>;
	readonly adapters?: ReadonlyArray<{ name: string; description?: string }>;

	dispose(): void | Promise<void>;

	send?(text: string, timeoutMs?: number): Promise<string>;
	receive?(text: string): void;

	getDirective?(): DirectiveView | undefined;

	subscribe(observer: (event: AgentEvent) => void): () => void;

	cancelToolCall?(callId: string, toolName: string): void;
}

// ---------------------------------------------------------------------------
// Type-narrowing helpers
// ---------------------------------------------------------------------------

/**
 *
 */
export function canSend(session: Session): session is Session & { send: NonNullable<Session["send"]> } {
	return typeof session.send === "function";
}

/**
 *
 */
export function canManageAdapters(session: Session): session is Session & {
	loadAdapter: NonNullable<Session["loadAdapter"]>;
	unloadAdapter: NonNullable<Session["unloadAdapter"]>;
} {
	return typeof session.loadAdapter === "function" && typeof session.unloadAdapter === "function";
}
