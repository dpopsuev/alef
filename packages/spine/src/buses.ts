import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// NerveEvent — base shape every bus event must extend.
// ---------------------------------------------------------------------------

export interface NerveEvent {
	readonly type: string;
	readonly correlationId: string;
	readonly timestamp: number;
}

// ---------------------------------------------------------------------------
// ToolDefinition — what an organ exposes to the LLM as a callable tool.
// The tool name IS the Motor event type the organ subscribes to.
// ---------------------------------------------------------------------------

export interface ToolDefinition {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Bus events — domain-agnostic. Spine knows nothing about payload schemas.
// Routing is by type string. Each organ package defines its own payloads.
//
//   MotorEvent: commands flowing OUT from cerebrum to corpus organs.
//   SenseEvent: observations flowing IN from corpus organs to cerebrum.
//   SignalEvent: audit events on both seams.
// ---------------------------------------------------------------------------

export interface MotorEvent extends NerveEvent {
	readonly type: string;
	readonly payload: Record<string, unknown>;
}

export interface SenseEvent extends NerveEvent {
	readonly type: string;
	readonly payload: Record<string, unknown>;
	readonly isError: boolean;
	readonly errorMessage?: string;
}

// ---------------------------------------------------------------------------
// Nerve — unified bidirectional view of both buses.
//
// Every organ receives a Nerve. Direction is declared via the action-map key
// prefix in defineOrgan: "motor/" subscribes Motor, "sense/" subscribes Sense.
// ---------------------------------------------------------------------------

export type MotorHandler = (event: MotorEvent) => void | Promise<void>;
export type SenseHandler = (event: SenseEvent) => void | Promise<void>;

export interface Nerve {
	readonly motor: {
		subscribe(type: string, handler: MotorHandler): () => void;
		publish(event: MotorEvent): void;
	};
	readonly sense: {
		subscribe(type: string, handler: SenseHandler): () => void;
		publish(event: SenseEvent): void;
	};
}

// ---------------------------------------------------------------------------
// Organ — unified interface. mount(nerve: Nerve) handles both bus directions.
// ---------------------------------------------------------------------------

export interface Organ {
	readonly name: string;
	readonly tools: readonly ToolDefinition[];
	mount(nerve: Nerve): () => void;
	/**
	 * Optional: declares which Motor and Sense event types this organ subscribes to.
	 * Set automatically by defineOrgan from the action map keys.
	 * Hand-crafted organs can declare this explicitly for SeamRegistry detection.
	 * If absent, the Agent probes by calling mount on a throw-away nerve.
	 */
	/**
	 * Declares which Motor and Sense event types this organ subscribes to.
	 * Required — the framework enforces this at compile time.
	 * defineOrgan fills it automatically from the action map keys.
	 * Hand-crafted organs must declare it explicitly.
	 * Agent.validate() reads this directly — no probe mount, no state corruption.
	 */
	readonly subscriptions: {
		readonly motor: readonly string[];
		readonly sense: readonly string[];
	};
	/**
	 * Optional ACI directives — organ-specific guidance injected into the system prompt.
	 * Assembled by DirectiveContextAssembler and prepended to the base prompt.
	 * Each string is a freeform instruction block (markdown or prose).
	 */
	readonly directives?: readonly string[];
}

// ---------------------------------------------------------------------------
// InProcessBus — internal routing with wildcard support for observability.
// ---------------------------------------------------------------------------

class InProcessBus {
	private readonly handlers = new Map<string, Set<(event: NerveEvent) => void | Promise<void>>>();

	emit(event: NerveEvent): void {
		const specific = this.handlers.get(event.type);
		if (specific) for (const h of specific) void h(event);
		const wildcard = this.handlers.get("*");
		if (wildcard) for (const h of wildcard) void h(event);
	}

	on(type: string, handler: (event: NerveEvent) => void | Promise<void>): () => void {
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

// ---------------------------------------------------------------------------
// InProcessNerve — provides CerebrumNerve and CorpusNerve views.
// Also exposes direct methods for the Agent composition root.
// ---------------------------------------------------------------------------

export class InProcessNerve {
	private readonly _sense = new InProcessBus();
	private readonly _motor = new InProcessBus();

	asNerve(): Nerve {
		return {
			motor: {
				subscribe: (type, h) => this._motor.on(type, h as (e: NerveEvent) => void | Promise<void>),
				publish: (e) => this._motor.emit(e),
			},
			sense: {
				subscribe: (type, h) => this._sense.on(type, h as (e: NerveEvent) => void | Promise<void>),
				publish: (e) => this._sense.emit(e),
			},
		};
	}

	// ── Direct access for the Agent ──────────────────────────────────────

	publishMotor(event: MotorEvent): void {
		this._motor.emit(event);
	}

	subscribeSense(type: string, handler: SenseHandler): () => void {
		return this._sense.on(type, handler as (e: NerveEvent) => void | Promise<void>);
	}

	publishSense(event: SenseEvent): void {
		this._sense.emit(event);
	}

	// ── Wildcard subscriptions for observability ────────────────────────────

	onAnyMotor(handler: (event: NerveEvent) => void): () => void {
		return this._motor.on("*", handler);
	}

	onAnySense(handler: (event: NerveEvent) => void): () => void {
		return this._sense.on("*", handler);
	}

	listenerCount(bus: "sense" | "motor", type: string): number {
		return bus === "sense" ? this._sense.listenerCount(type) : this._motor.listenerCount(type);
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function newCorrelationId(): string {
	return randomUUID();
}
