/**
 * Session — the Strategy interface between the TUI and a running agent.
 *
 * Two concrete strategies:
 *   LocalSession  — agent runs in the same process as the TUI
 *   RemoteSession — agent runs as a daemon; TUI connects via RouterOrgan SSE
 *
 * The TUI is ignorant of which strategy it holds. Strategy selection happens
 * at construction time (main.ts) or at :session attach (CommandRegistry).
 *
 * AgentEvent is the typed output channel. All agent → TUI communication
 * flows through subscribe(observer). This replaces the five scattered
 * toolSlot callbacks (onToolStart, onToolEnd, onTokenUsage,
 * receiveTextChunk, receiveThinkingChunk).
 *
 * Related: strangler fig, daemon + registry.
 */

// ---------------------------------------------------------------------------
// AgentEvent — typed output from the agent to any observer.
// Types are owned here; they are structurally identical to organ-llm types
// but session.ts must not depend on organ packages.
// ---------------------------------------------------------------------------

export interface ToolStarted {
	callId: string;
	name: string;
	args: Record<string, unknown>;
}

export interface ToolEnded {
	callId: string;
	elapsedMs: number;
	ok: boolean;
	display?: string;
	displayKind?: string;
}

export interface TokensConsumed {
	input: number;
	output: number;
	totalTokens: number;
}

export type AgentEvent =
	| { type: "chunk"; text: string }
	| { type: "thinking"; text: string }
	| { type: "tool-start"; callId: string; name: string; args: Record<string, unknown> }
	| { type: "tool-end"; callId: string; elapsedMs: number; ok: boolean; display?: string; displayKind?: string }
	| { type: "turn-complete"; reply: string }
	| { type: "turn-error"; message: string }
	| { type: "token-usage"; usage: TokensConsumed };

// ---------------------------------------------------------------------------
// DirectiveView — the minimal surface Session exposes from the directive system.
// Callers never see DirectiveAdapter from organ-alef.
// ---------------------------------------------------------------------------

export interface DirectiveView {
	list(): ReadonlyArray<{ id: string; priority: number; enabled: boolean; tags?: string[] }>;
	enable(id: string): void;
	disable(id: string): void;
	toggle(id: string): void;
}

// ---------------------------------------------------------------------------
// SessionState — stable identity, serialisable, survives attach/detach
// ---------------------------------------------------------------------------

export interface SessionState {
	readonly id: string;
	readonly modelId: string;
	readonly contextWindow: number;
}

// ---------------------------------------------------------------------------
// Session — Strategy interface
// ---------------------------------------------------------------------------

export interface Session {
	readonly state: SessionState;

	// Model and thinking configuration
	getModel(): string;
	setModel(id: string): void;
	getThinking(): string;
	setThinking(level: string): void;

	// Turn control — TUI injects an AbortController to cancel the live turn
	setTurnController(ctrl: AbortController | undefined): void;

	// Organ management — optional; absent when the session does not support it
	loadOrgan?(path: string): Promise<void>;
	unloadOrgan?(name: string): boolean;
	reloadOrgan?(name: string, path: string): Promise<void>;

	// Lifecycle
	dispose(): void;

	// Conversation — optional based on mode
	/** Await a full reply. Absent in observer and replay modes. */
	send?(text: string, timeoutMs?: number): Promise<string>;
	/** Fire-and-forget inbound message. Used by SSE serve mode (router organ). */
	receive?(text: string): void;

	// Session-level access to the directive system
	getDirective?(): DirectiveView | undefined;

	// Observer registration — returns the unsubscribe function (= detach)
	subscribe(observer: (event: AgentEvent) => void): () => void;
}

// ---------------------------------------------------------------------------
// Type-narrowing helpers
// ---------------------------------------------------------------------------

export function canSend(session: Session): session is Session & { send: NonNullable<Session["send"]> } {
	return typeof session.send === "function";
}

export function canManageOrgans(session: Session): session is Session & {
	loadOrgan: NonNullable<Session["loadOrgan"]>;
	unloadOrgan: NonNullable<Session["unloadOrgan"]>;
} {
	return typeof session.loadOrgan === "function" && typeof session.unloadOrgan === "function";
}

// ---------------------------------------------------------------------------
// makeToolSlotFromSession — bridge from Session.subscribe to Cerebrum callbacks.
// Translates organ-llm callback shapes to AgentEvent without importing organ types.
// ---------------------------------------------------------------------------

export function makeToolSlotFromSession(session: Session): {
	onToolStart: ((e: ToolStarted) => void) | undefined;
	onToolEnd: ((e: ToolEnded) => void) | undefined;
	onTokenUsage: ((u: TokensConsumed) => void) | undefined;
	receiveTextChunk: ((chunk: string) => void) | undefined;
	receiveThinkingChunk: ((chunk: string) => void) | undefined;
} {
	let dispatch: ((event: AgentEvent) => void) | undefined;
	session.subscribe((event) => dispatch?.(event));

	return {
		onToolStart: (e) => dispatch?.({ type: "tool-start", callId: e.callId, name: e.name, args: e.args }),
		onToolEnd: (e) =>
			dispatch?.({
				type: "tool-end",
				callId: e.callId,
				elapsedMs: e.elapsedMs,
				ok: e.ok,
				display: e.display,
				displayKind: e.displayKind,
			}),
		onTokenUsage: (u) => dispatch?.({ type: "token-usage", usage: u }),
		receiveTextChunk: (chunk) => dispatch?.({ type: "chunk", text: chunk }),
		receiveThinkingChunk: (chunk) => dispatch?.({ type: "thinking", text: chunk }),
	};
}
