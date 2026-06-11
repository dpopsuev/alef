import { randomUUID } from "node:crypto";
import { type ZodRawShape, type ZodTypeAny, z } from "zod";

export interface NerveEvent {
	readonly type: string;
	readonly correlationId: string;
	readonly timestamp: number;
	readonly elapsed: number;
}

export interface SkillPage {
	readonly name: string;
	readonly description: string;
	readonly instructions: string;
}

export interface SkillBook {
	readonly name: string;
	readonly description: string;
	readonly pages: readonly SkillPage[];
}

export interface AgentRunContext {
	prependInstructions(text: string): void;
	addOrgans(organs: Organ[]): void;
}

export interface AgentRunContribution {
	/** Additional Zod fields merged into the agent.run inputSchema when this contribution is active. */
	schema?: ZodRawShape;
	extend(args: Record<string, unknown>, context: AgentRunContext): Promise<void> | void;
}

export function createCompositeAgentRunContribution(): AgentRunContribution & {
	add(organName: string, contribution: AgentRunContribution): void;
	remove(organName: string): void;
	mergedSchema(): ZodRawShape;
} {
	const children = new Map<string, AgentRunContribution>();
	return {
		add(organName, contribution) {
			children.set(organName, contribution);
		},
		remove(organName) {
			children.delete(organName);
		},
		mergedSchema() {
			const merged: ZodRawShape = {};
			for (const child of children.values()) Object.assign(merged, child.schema ?? {});
			return merged;
		},
		async extend(args, context) {
			for (const child of children.values()) await child.extend(args, context);
		},
	};
}

export interface OrganContributions {
	readonly "agent.run"?: AgentRunContribution;
	readonly skills?: readonly SkillBook[];
	/** Provides full tool schemas for timeout calculation — populated by ToolShell. */
	readonly "schema-resolver"?: (toolName: string) => ToolDefinition | undefined;
}

export interface ToolDefinition {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: ZodTypeAny;
	readonly streaming?: true;
}

/**
 * Wrap a raw JSON Schema object as a ZodTypeAny so it satisfies ToolDefinition.inputSchema.
 * Use this in adapters (e.g. McpOrgan) where the schema arrives as JSON Schema at runtime
 * and cannot be expressed as a Zod schema at compile time.
 *
 * toolInputToJsonSchema() detects this wrapper and returns the raw schema directly.
 */
const passthroughRawMap = new WeakMap<ZodTypeAny, Record<string, unknown>>();

export function passthroughSchema(raw: Record<string, unknown>): ZodTypeAny {
	const schema = z.unknown();
	passthroughRawMap.set(schema, raw);
	return schema;
}

export function toolInputToJsonSchema(schema: ZodTypeAny): Record<string, unknown> {
	const raw = passthroughRawMap.get(schema);
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
//   MotorEvent: commands flowing OUT from the LLM organ to organs.
//   SenseEvent: observations flowing IN from organs to the LLM organ.
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
	/** Reset the nerve-level liveness watchdog. Called automatically by organ-dispatch on every event. */
	pulse(): void;
}

/** A function that wraps a Nerve to intercept motor/sense events. Composable middleware. */
export type NerveMiddleware = (nerve: Nerve) => Nerve;

// ---------------------------------------------------------------------------
// Organ — unified interface. mount(nerve: Nerve) handles both bus directions.
// ---------------------------------------------------------------------------

export interface Organ {
	readonly name: string;
	readonly tools: readonly ToolDefinition[];
	mount(nerve: Nerve): () => void;
	/** Async resource teardown — called after unmount() on dispose. MCP organs use this to close subprocesses. */
	close?(): Promise<void>;
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
	 * Cross-organ contributions collected by aggregator organs via sense/organ.loaded.
	 * Each key is a well-known contribution type enforced by the kernel.
	 */
	readonly contributions?: OrganContributions;
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
	 *   motor: { "llm.response": z.object({ text: z.string() }) },
	 *   sense: { "fs.read":      z.object({ content: z.string(), truncated: z.boolean() }) },
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
 * Reasoner — kernel-level interface for the agent's reasoning component.
 *
 * A Reasoner is NOT an Organ in the microkernel sense: it provides no tools,
 * does not respond to tool-call commands, and is not called by the LLM.
 * It is the component that CALLS organs and drives the agent loop.
 *
 * Distinguishing properties:
 *   - tools is always empty (Reasoner never appears in the tool catalog)
 *   - triggerEvent is the sense event that starts a turn (configurable — any sense event)
 *   - replyEvent is the motor event published when the turn completes
 *
 * Multiple implementations are possible: organ-llm (real LLM), ScriptedReasoner
 * (deterministic test double), or future alternatives. The triggerEvent parameter
 * enables ambient agents driven by any sense event, not just llm.input.
 */
export interface Reasoner extends Organ {
	readonly tools: readonly [];
	readonly triggerEvent: string;
	readonly replyEvent: string;
}

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

export { InProcessNerve } from "./in-process-nerve.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function newCorrelationId(): string {
	return randomUUID();
}
