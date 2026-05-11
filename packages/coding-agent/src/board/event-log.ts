/**
 * EventLog — append-only event log with sequential indexing.
 *
 * KISS EDA core. Ported from tangle/signal: Event + EventLog + MemLog.
 *
 * Design:
 *   - Events are immutable facts (never modified after emit)
 *   - Sequential index (0-based) for cursor-based consumption
 *   - OnEmit hooks for real-time subscribers
 *   - Since(index) for replay/catch-up
 *   - Typed via `kind` string + `data` payload (consumers type-switch)
 *
 * This replaces the ephemeral EventEmitter pattern with a persistent,
 * replayable log. The existing EventBus/AgentEvent system continues to
 * work — this log captures events at a higher level for cross-system
 * coordination (memory, board, broker, supervisor).
 */

import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Event — the universal envelope
// ---------------------------------------------------------------------------

export interface Event<T = unknown> {
	/** Unique event ID */
	id: string;
	/** Parent event ID (for causal chains) */
	parentId?: string;
	/** Trace ID (groups related events across agents) */
	traceId?: string;
	/** When it happened */
	timestamp: number;
	/** Who emitted it (agent color, "supervisor", "system") */
	source: string;
	/** Event type discriminator */
	kind: string;
	/** Domain-specific payload — consumers type-switch on kind */
	data: T;
	/** Sequential index in the log (set by the log, not the emitter) */
	index?: number;
}

// ---------------------------------------------------------------------------
// Well-known event kinds
// ---------------------------------------------------------------------------

export const EVENT_KINDS = {
	// Agent lifecycle
	AGENT_SPAWNED: "agent.spawned",
	AGENT_STOPPED: "agent.stopped",
	AGENT_HEARTBEAT: "agent.heartbeat",

	// User interaction
	USER_INPUT: "user.input",
	ASSISTANT_OUTPUT: "assistant.output",

	// Tool execution
	TOOL_CALLED: "tool.called",
	TOOL_RESULT: "tool.result",

	// Memory
	MEMORY_EXTRACTED: "memory.extracted",
	MEMORY_LINKED: "memory.linked",
	MEMORY_COMPACTED: "memory.compacted",
	MEMORY_RECALLED: "memory.recalled",
	MEMORY_CONFLICT: "memory.conflict",

	// Board
	BOARD_ENTRY: "board.entry",
	BOARD_EDGE: "board.edge",

	// Contract
	CONTRACT_CREATED: "contract.created",
	CONTRACT_STAGE_STARTED: "contract.stage.started",
	CONTRACT_STAGE_COMPLETED: "contract.stage.completed",
	CONTRACT_BREAKPOINT: "contract.breakpoint",
	CONTRACT_COMPLETED: "contract.completed",

	// System
	BUILD_STARTED: "system.build.started",
	BUILD_COMPLETED: "system.build.completed",
	BUILD_FAILED: "system.build.failed",
	PREFLIGHT_PASSED: "system.preflight.passed",
	PREFLIGHT_FAILED: "system.preflight.failed",
} as const;

export type EventKind = (typeof EVENT_KINDS)[keyof typeof EVENT_KINDS];

// ---------------------------------------------------------------------------
// EventLog — append-only log with sequential indexing
// ---------------------------------------------------------------------------

export type EmitHook = (event: Event) => void;
export type FilterFn = (event: Event) => boolean;

export interface EventLog {
	/** Append an event. Returns the sequential index. */
	emit(event: Omit<Event, "id" | "index" | "timestamp"> & { timestamp?: number }): number;

	/** Read events from index onward (inclusive). Returns empty if index >= len. */
	since(index: number): Event[];

	/** Total events in the log */
	len(): number;

	/** Register a callback fired on every emit */
	onEmit(hook: EmitHook): () => void;

	/** Subscribe with a filter — only matching events fire the hook */
	subscribe(filter: FilterFn, hook: EmitHook): () => void;
}

// ---------------------------------------------------------------------------
// EventStore — durable persistence port (hexagonal)
// ---------------------------------------------------------------------------

export interface EventStore {
	append(event: Event): Promise<void>;
	readSince(index: number): Promise<Event[]>;
	len(): Promise<number>;
	close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// MemLog — in-memory EventLog implementation
// ---------------------------------------------------------------------------

export class MemLog implements EventLog {
	private events: Event[] = [];
	private hooks: EmitHook[] = [];

	emit(partial: Omit<Event, "id" | "index" | "timestamp"> & { timestamp?: number }): number {
		const index = this.events.length;
		const event: Event = {
			...partial,
			id: randomUUID(),
			timestamp: partial.timestamp ?? Date.now(),
			index,
		};
		this.events.push(event);

		for (const hook of this.hooks) {
			try {
				hook(event);
			} catch {
				// Hooks must not break the log
			}
		}

		return index;
	}

	since(index: number): Event[] {
		if (index < 0) index = 0;
		if (index >= this.events.length) return [];
		return this.events.slice(index);
	}

	len(): number {
		return this.events.length;
	}

	onEmit(hook: EmitHook): () => void {
		this.hooks.push(hook);
		return () => {
			const idx = this.hooks.indexOf(hook);
			if (idx !== -1) this.hooks.splice(idx, 1);
		};
	}

	subscribe(filter: FilterFn, hook: EmitHook): () => void {
		const wrapped: EmitHook = (event) => {
			if (filter(event)) hook(event);
		};
		return this.onEmit(wrapped);
	}
}

// ---------------------------------------------------------------------------
// Helper: create events with less boilerplate
// ---------------------------------------------------------------------------

export function createEvent<T>(
	kind: string,
	source: string,
	data: T,
	parentId?: string,
	traceId?: string,
): Omit<Event<T>, "id" | "index" | "timestamp"> {
	return { kind, source, data, parentId, traceId };
}

// ---------------------------------------------------------------------------
// Helper: filter builders
// ---------------------------------------------------------------------------

export function byKind(...kinds: string[]): FilterFn {
	const set = new Set(kinds);
	return (event) => set.has(event.kind);
}

export function bySource(source: string): FilterFn {
	return (event) => event.source === source;
}

export function byTrace(traceId: string): FilterFn {
	return (event) => event.traceId === traceId;
}
