import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// NerveEvent — base shape every bus event must extend.
// ---------------------------------------------------------------------------

export interface NerveEvent {
	/** Discriminant. Unique within each bus (Sense / Motor / Signal). */
	readonly type: string;
	/** Ties all events belonging to one logical turn together. */
	readonly correlationId: string;
	/** Unix ms. */
	readonly timestamp: number;
}

// ---------------------------------------------------------------------------
// ToolDefinition — what an organ exposes to the LLM as a callable tool.
// The tool name IS the Motor/tool_call event type the organ subscribes to.
// ---------------------------------------------------------------------------

export interface ToolDefinition {
	readonly name: string;
	readonly description: string;
	/** JSON Schema for the tool's input arguments. */
	readonly inputSchema: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Sense events — afferent, flowing INTO the system (perceptions).
// ---------------------------------------------------------------------------

export interface UserMessageEvent extends NerveEvent {
	readonly type: "user_message";
	readonly text: string;
	/** Tool definitions from all organs loaded into Corpus at the time of this message. */
	readonly tools: readonly ToolDefinition[];
}

export interface ToolResultEvent extends NerveEvent {
	readonly type: "tool_result";
	readonly toolName: string;
	readonly result: unknown;
	readonly isError: boolean;
	readonly errorMessage?: string;
}

export type SenseEvent = UserMessageEvent | ToolResultEvent;

// ---------------------------------------------------------------------------
// Motor events — efferent, flowing OUT FROM the system (actions).
// ---------------------------------------------------------------------------

export interface LLMRequestEvent extends NerveEvent {
	readonly type: "llm_request";
	/** Conversation messages in AI provider format. */
	readonly messages: readonly unknown[];
	/** Tool definitions from all loaded organs, including send_message. */
	readonly tools: readonly ToolDefinition[];
}

export interface ToolCallEvent extends NerveEvent {
	readonly type: "tool_call";
	/** Matches the tool's ToolDefinition.name — routes to the subscribed organ. */
	readonly toolName: string;
	readonly args: Record<string, unknown>;
}

export interface UserReplyEvent extends NerveEvent {
	readonly type: "user_reply";
	readonly text: string;
}

export type MotorEvent = LLMRequestEvent | ToolCallEvent | UserReplyEvent;

// ---------------------------------------------------------------------------
// Signal events — audit, both seams (supervisor.corpus and corpus.organ).
// ---------------------------------------------------------------------------

export interface SignalEvent extends NerveEvent {
	readonly type: "signal";
	readonly signal: "execute" | "result.ok" | "result.error";
	readonly organ?: string;
	readonly eventType?: string;
	readonly details?: string;
}

// ---------------------------------------------------------------------------
// Typed bus interfaces.
// ---------------------------------------------------------------------------

type SenseHandler = (event: SenseEvent) => void | Promise<void>;
type MotorHandler = (event: MotorEvent) => void | Promise<void>;
type SignalHandler = (event: SignalEvent) => void | Promise<void>;

export interface SenseBus {
	/** Emit a Sense event (perception entering the system). */
	emit(event: SenseEvent): void;
	/**
	 * Subscribe to a Sense event type.
	 * @returns unsubscribe function.
	 */
	on(type: SenseEvent["type"], handler: SenseHandler): () => void;
}

export interface MotorBus {
	/** Emit a Motor event (action leaving the system). */
	emit(event: MotorEvent): void;
	/**
	 * Subscribe to a Motor event type.
	 * For tool organs: subscribe to "tool_call" and filter by toolName.
	 * @returns unsubscribe function.
	 */
	on(type: MotorEvent["type"], handler: MotorHandler): () => void;
}

export interface SignalBus {
	/** Emit a Signal event (audit record). */
	emit(event: SignalEvent): void;
	/** Subscribe to all Signal events. @returns unsubscribe function. */
	on(type: SignalEvent["type"], handler: SignalHandler): () => void;
}

// ---------------------------------------------------------------------------
// Nerve — the 3-bus bundle passed to organs at mount time.
// ---------------------------------------------------------------------------

export interface Nerve {
	readonly sense: SenseBus;
	readonly motor: MotorBus;
	readonly signal: SignalBus;
}

// ---------------------------------------------------------------------------
// Organ — the contract every organ in the Pub-Sub model must satisfy.
// ---------------------------------------------------------------------------

export interface Organ {
	/** Canonical organ name. */
	readonly name: string;
	/**
	 * LLM tool definitions this organ exposes.
	 * The tool name IS the Motor/tool_call.toolName the organ subscribes to.
	 * Empty array for organs that don't expose LLM tools.
	 */
	readonly tools: readonly ToolDefinition[];
	/**
	 * Mount onto the Nerve: subscribe to bus channels, return unmount.
	 * Called once by Corpus at load time. After this, events drive execution.
	 */
	mount(nerve: Nerve): () => void;
}

// ---------------------------------------------------------------------------
// InProcessNerve — the single in-process Nerve implementation.
//
// Fan-out delivery: all subscribers for an event type are called in
// registration order. Async handlers are fire-and-forget (not awaited by
// emit) — organs must handle their own error boundaries.
// ---------------------------------------------------------------------------

class InProcessBus<TEvent extends NerveEvent> {
	private readonly handlers = new Map<string, Set<(event: TEvent) => void | Promise<void>>>();

	emit(event: TEvent): void {
		const set = this.handlers.get(event.type);
		if (!set) return;
		for (const h of set) {
			void h(event);
		}
	}

	on(type: string, handler: (event: TEvent) => void | Promise<void>): () => void {
		let set = this.handlers.get(type);
		if (!set) {
			set = new Set();
			this.handlers.set(type, set);
		}
		set.add(handler);
		return () => {
			set!.delete(handler);
		};
	}

	listenerCount(type: string): number {
		return this.handlers.get(type)?.size ?? 0;
	}
}

export class InProcessNerve implements Nerve {
	private readonly _sense = new InProcessBus<SenseEvent>();
	private readonly _motor = new InProcessBus<MotorEvent>();
	private readonly _signal = new InProcessBus<SignalEvent>();

	readonly sense: SenseBus = {
		emit: (e) => this._sense.emit(e),
		on: (type, h) => this._sense.on(type, h),
	};

	readonly motor: MotorBus = {
		emit: (e) => this._motor.emit(e),
		on: (type, h) => this._motor.on(type, h),
	};

	readonly signal: SignalBus = {
		emit: (e) => this._signal.emit(e),
		on: (type, h) => this._signal.on(type, h),
	};

	/** Convenience: how many handlers are subscribed on a given bus + type. */
	listenerCount(bus: "sense" | "motor" | "signal", type: string): number {
		return bus === "sense"
			? this._sense.listenerCount(type)
			: bus === "motor"
				? this._motor.listenerCount(type)
				: this._signal.listenerCount(type);
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a correlationId for a new top-level turn. */
export function newCorrelationId(): string {
	return randomUUID();
}
