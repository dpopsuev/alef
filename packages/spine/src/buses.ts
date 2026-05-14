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

export interface SignalEvent extends NerveEvent {
	readonly type: "signal";
	readonly signal: "execute" | "result.ok" | "result.error";
	readonly organ?: string;
	readonly eventType?: string;
	readonly details?: string;
}

// ---------------------------------------------------------------------------
// Nerve interfaces — ISP-segregated by mutation target.
//
// CerebrumNerve — given to CerebrumOrgans (organs that mutate agent state).
//   The brain is shielded from the external world. It only sees the Spine.
//   Subscribes Sense (observations), publishes Motor (commands).
//   Example: LLMOrgan — mutates agent reasoning.
//
// CorpusNerve — given to CorpusOrgans (organs that mutate the world).
//   Body organs cross the external boundary: files, processes, users.
//   Subscribes Motor (commands), publishes Sense (results).
//   Example: FilesystemOrgan, ShellOrgan, TextMessageOrgan.
// ---------------------------------------------------------------------------

type MotorHandler = (event: MotorEvent) => void | Promise<void>;
type SenseHandler = (event: SenseEvent) => void | Promise<void>;

export interface CerebrumNerve {
	readonly sense: {
		subscribe(type: string, handler: SenseHandler): () => void;
	};
	readonly motor: {
		publish(event: MotorEvent): void;
	};
	readonly signal: {
		publish(event: SignalEvent): void;
	};
}

export interface CorpusNerve {
	readonly motor: {
		subscribe(type: string, handler: MotorHandler): () => void;
	};
	readonly sense: {
		publish(event: SenseEvent): void;
	};
	readonly signal: {
		publish(event: SignalEvent): void;
	};
}

// ---------------------------------------------------------------------------
// Organ interfaces — discriminated by kind so Corpus can route the nerve.
// ---------------------------------------------------------------------------

export interface CerebrumOrgan {
	/** Discriminant — Corpus routes CerebrumNerve to this organ. */
	readonly kind: "cerebrum";
	readonly name: string;
	readonly tools: readonly ToolDefinition[];
	mount(nerve: CerebrumNerve): () => void;
}

export interface CorpusOrgan {
	/** Discriminant — Corpus routes CorpusNerve to this organ. */
	readonly kind: "corpus";
	readonly name: string;
	readonly tools: readonly ToolDefinition[];
	mount(nerve: CorpusNerve): () => void;
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
// Also exposes direct methods for the Corpus composition root.
// ---------------------------------------------------------------------------

export class InProcessNerve {
	private readonly _sense = new InProcessBus();
	private readonly _motor = new InProcessBus();
	private readonly _signal = new InProcessBus();

	/** View for CerebrumOrgans: subscribe Sense, publish Motor. */
	asCerebrumNerve(): CerebrumNerve {
		return {
			sense: { subscribe: (type, h) => this._sense.on(type, h as (e: NerveEvent) => void | Promise<void>) },
			motor: { publish: (e) => this._motor.emit(e) },
			signal: { publish: (e) => this._signal.emit(e) },
		};
	}

	/** View for CorpusOrgans: subscribe Motor, publish Sense. */
	asCorpusNerve(): CorpusNerve {
		return {
			motor: { subscribe: (type, h) => this._motor.on(type, h as (e: NerveEvent) => void | Promise<void>) },
			sense: { publish: (e) => this._sense.emit(e) },
			signal: { publish: (e) => this._signal.emit(e) },
		};
	}

	// ── Direct access for the Corpus composition root ──────────────────────

	publishMotor(event: MotorEvent): void {
		this._motor.emit(event);
	}

	subscribeSense(type: string, handler: SenseHandler): () => void {
		return this._sense.on(type, handler as (e: NerveEvent) => void | Promise<void>);
	}

	publishSignal(event: SignalEvent): void {
		this._signal.emit(event);
	}

	// ── Wildcard subscriptions for observability (BusEventRecorder) ────────

	onAnyMotor(handler: (event: NerveEvent) => void): () => void {
		return this._motor.on("*", handler);
	}

	onAnySense(handler: (event: NerveEvent) => void): () => void {
		return this._sense.on("*", handler);
	}

	onAnySignal(handler: (event: NerveEvent) => void): () => void {
		return this._signal.on("*", handler);
	}

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

export function newCorrelationId(): string {
	return randomUUID();
}
