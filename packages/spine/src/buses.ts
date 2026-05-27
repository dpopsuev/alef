import { randomUUID } from "node:crypto";
import { type ZodTypeAny, z } from "zod";

// ---------------------------------------------------------------------------
// NerveEvent — base shape every bus event must extend.
// ---------------------------------------------------------------------------

export interface NerveEvent {
	readonly type: string;
	readonly correlationId: string;
	/** Epoch ms — set by the bus at emit time. Organs do not set this. */
	readonly timestamp: number;
	/** Ms since the first event with this correlationId was seen. Set by the bus. */
	readonly elapsed: number;
}

// ---------------------------------------------------------------------------
// ToolDefinition — what an organ exposes to the LLM as a callable tool.
// The tool name IS the Motor event type the organ subscribes to.
// ---------------------------------------------------------------------------

export interface ToolDefinition {
	readonly name: string;
	readonly description: string;
	/**
	 * Input schema for this tool. Must be a Zod schema — enforced by the
	 * framework. Use z.object({}) for tools that take no arguments.
	 * Cerebrum converts to JSON Schema via z.toJSONSchema() before the provider.
	 */
	readonly inputSchema: ZodTypeAny;
}

/**
 * Wrap a raw JSON Schema object as a ZodTypeAny so it satisfies ToolDefinition.inputSchema.
 * Use this in adapters (e.g. McpOrgan) where the schema arrives as JSON Schema at runtime
 * and cannot be expressed as a Zod schema at compile time.
 *
 * toolInputToJsonSchema() detects this wrapper and returns the raw schema directly.
 */
export function passthroughSchema(raw: Record<string, unknown>): ZodTypeAny {
	const schema = z.unknown();
	(schema as unknown as { _passthroughRaw: Record<string, unknown> })._passthroughRaw = raw;
	return schema;
}

/**
 * Convert a ToolDefinition's inputSchema to a plain JSON Schema object.
 */
export function toolInputToJsonSchema(schema: ZodTypeAny): Record<string, unknown> {
	// Passthrough schemas (e.g. from McpOrgan) carry raw JSON Schema directly.
	const raw = (schema as unknown as { _passthroughRaw?: Record<string, unknown> })._passthroughRaw;
	if (raw !== undefined) return raw;

	const js = z.toJSONSchema(schema) as Record<string, unknown>;
	// Remove $schema key — providers don't need it and some reject it.
	const { $schema: _, ...rest } = js as Record<string, unknown> & { $schema?: string };
	return rest;
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

/**
 * What organs pass to publish. The bus stamps timestamp and elapsed — organs
 * must not set them. Passing a timestamp is a compile-time error.
 */
export type MotorPublishInput = Omit<MotorEvent, "timestamp" | "elapsed">;
export type SensePublishInput = Omit<SenseEvent, "timestamp" | "elapsed">;

export interface Nerve {
	readonly motor: {
		subscribe(type: string, handler: MotorHandler): () => void;
		publish(event: MotorPublishInput): void;
	};
	readonly sense: {
		subscribe(type: string, handler: SenseHandler): () => void;
		publish(event: SensePublishInput): void;
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
	/**
	 * Short human-readable description of what this organ does.
	 * Shown in --list-organs and blueprint validation output.
	 */
	readonly description?: string;
	/**
	 * Freeform labels for categorisation and discovery.
	 * Examples: ["filesystem", "readonly"], ["shell", "exec"], ["llm", "reasoning"]
	 * Used for filtering in --list-organs and future organ registries.
	 */
	readonly labels?: readonly string[];
	/**
	 * Zod payload schemas for events this organ publishes.
	 *
	 * Validated by Agent.load() when ALEF_VALIDATE_PAYLOADS=1 or NODE_ENV=test.
	 * A failing schema throws immediately at publish time with the organ name,
	 * event type, and Zod error — not two turns into a real LLM session.
	 *
	 * motor: schemas for events published on the motor bus.
	 * sense: schemas for events published on the sense bus.
	 *
	 * @example
	 * publishSchemas: {
	 *   motor: { "dialog.message": z.object({ text: z.string() }) },
	 *   sense: { "fs.read":        z.object({ content: z.string(), truncated: z.boolean() }) },
	 * }
	 */
	readonly publishSchemas?: {
		readonly motor?: Readonly<Record<string, ZodTypeAny>>;
		readonly sense?: Readonly<Record<string, ZodTypeAny>>;
	};
	/** Zod schemas for incoming motor payloads, validated by the framework before dispatch. */
	readonly inputSchemas?: {
		readonly motor?: Readonly<Record<string, ZodTypeAny>>;
	};
	/**
	 * Optional async initialization. Agent.ready() awaits all loaded organs that
	 * declare ready() before routing any events. Use for LSP warm-up, DB connections,
	 * container starts — anything that must complete before the first event arrives.
	 */
	ready?(): Promise<void>;
}

// ---------------------------------------------------------------------------
// GimpedOrgan — explicit ablation primitive.
//
// An organ is "gimped" when it has no tools and no subscriptions: it receives
// nothing, contributes nothing, but the system still runs. Gimped organs are
// used in ablation studies to measure a real organ's contribution by replacing
// it with a pass-through and comparing scores.
//
// Mirrors Tako reactivity.GimpedNode: no directives → always pass-through.
// ---------------------------------------------------------------------------

/**
 * Returns true when an organ contributes nothing to the system:
 * zero tools, zero motor subscriptions, zero sense subscriptions.
 * Use in ablation studies to assert a component was effectively removed.
 */
export function isGimped(organ: Organ): boolean {
	return organ.tools.length === 0 && organ.subscriptions.motor.length === 0 && organ.subscriptions.sense.length === 0;
}

/**
 * Create an explicit no-op organ for ablation.
 * Mounts cleanly, subscribes to nothing, exposes no tools.
 * Replaces a real organ to establish a baseline (ablated) measurement.
 */
export function gimpedOrgan(name: string): Organ {
	return {
		name,
		tools: [],
		subscriptions: { motor: [], sense: [] },
		mount: () => () => {},
	};
}

// ---------------------------------------------------------------------------
// InProcessBus — internal routing with wildcard support for observability.
// ---------------------------------------------------------------------------

/** Max correlationId entries retained in firstSeen before LRU eviction (ALE-BUG-15). */
const FIRST_SEEN_MAX = 500;

class InProcessBus {
	private readonly handlers = new Map<string, Set<(event: NerveEvent) => void | Promise<void>>>();
	/**
	 * Tracks the first-seen timestamp per correlationId to compute elapsed time.
	 * Insertion-ordered Map — oldest entry is first(). Capped at FIRST_SEEN_MAX
	 * to prevent unbounded growth in long-running sessions (ALE-BUG-15).
	 */
	readonly firstSeen = new Map<string, number>();
	/**
	 * Called when a motor event has no specific subscribers.
	 * Set by InProcessNerve to publish an error sense response.
	 * Wildcard subscribers (SessionLog, EvaluatorOrgan) do not count.
	 */
	deadLetterSink?: (event: NerveEvent) => void;

	/** Remove a correlationId from firstSeen (call when sense response arrives). */
	evictCorrelation(correlationId: string): void {
		this.firstSeen.delete(correlationId);
	}

	emit(input: Omit<NerveEvent, "timestamp" | "elapsed">): void {
		const now = Date.now();
		if (!this.firstSeen.has(input.correlationId)) {
			this.firstSeen.set(input.correlationId, now);
			// LRU eviction: remove oldest entry when cap is exceeded.
			if (this.firstSeen.size > FIRST_SEEN_MAX) {
				const oldest = this.firstSeen.keys().next().value;
				if (oldest !== undefined) this.firstSeen.delete(oldest);
			}
		}
		const startedAt = this.firstSeen.get(input.correlationId) ?? now;
		const elapsed = now - startedAt;
		const event: NerveEvent = { ...input, timestamp: now, elapsed };
		const specific = this.handlers.get(event.type);
		if (specific && specific.size > 0) {
			for (const h of specific) void h(event);
		} else {
			this.deadLetterSink?.(event);
		}
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
			set?.delete(handler);
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

	constructor() {
		this._motor.deadLetterSink = (event) => {
			const payload = (event as MotorEvent).payload;
			const toolCallId = typeof payload?.toolCallId === "string" ? payload.toolCallId : undefined;
			// Cast required: _sense.emit takes Omit<NerveEvent, temporal fields>
			// but the dead letter carries SenseEvent fields (payload, isError).
			this._sense.emit({
				type: event.type,
				correlationId: event.correlationId,
				payload: toolCallId ? { toolCallId } : {},
				isError: true,
				errorMessage: `no organ handles motor/${event.type}`,
			} as unknown as Omit<NerveEvent, "timestamp" | "elapsed">);
		};
	}

	asNerve(): Nerve {
		return {
			motor: {
				subscribe: (type, h) => this._motor.on(type, h as (e: NerveEvent) => void | Promise<void>),
				publish: (e) => this._motor.emit(e),
			},
			sense: {
				subscribe: (type, h) => this._sense.on(type, h as (e: NerveEvent) => void | Promise<void>),
				// Evict the correlationId from motor's firstSeen on sense publish:
				// the sense response marks the correlation as complete (ALE-BUG-15).
				publish: (e) => {
					this._motor.evictCorrelation(e.correlationId);
					this._sense.emit(e);
				},
			},
		};
	}

	// ── Direct access for the Agent ──────────────────────────────────────

	publishMotor(event: MotorPublishInput): void {
		this._motor.emit(event);
	}

	subscribeSense(type: string, handler: SenseHandler): () => void {
		return this._sense.on(type, handler as (e: NerveEvent) => void | Promise<void>);
	}

	publishSense(event: SensePublishInput): void {
		this._motor.evictCorrelation(event.correlationId);
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
