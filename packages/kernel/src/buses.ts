import { randomUUID } from "node:crypto";
import { type ZodRawShape, type ZodTypeAny, z } from "zod";
import type { DomainCondition } from "./reconciliation.js";

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
	addAdapters(adapters: Adapter[]): void;
	/** @deprecated Use addAdapters */
	addOrgans(organs: Adapter[]): void;
}

export interface AgentRunContribution {
	/** Additional Zod fields merged into the agent.run inputSchema when this contribution is active. */
	schema?: ZodRawShape;
	extend(args: Record<string, unknown>, context: AgentRunContext): Promise<void> | void;
}

export function createCompositeAgentRunContribution(): AgentRunContribution & {
	add(adapterName: string, contribution: AgentRunContribution): void;
	remove(adapterName: string): void;
	mergedSchema(): ZodRawShape;
} {
	const children = new Map<string, AgentRunContribution>();
	return {
		add(adapterName, contribution) {
			children.set(adapterName, contribution);
		},
		remove(adapterName) {
			children.delete(adapterName);
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

/** Input to a context.assemble pipeline stage — messages are opaque to the kernel. */
export interface ContextAssemblyInput {
	readonly messages: readonly unknown[];
	readonly tools: readonly ToolDefinition[];
	readonly turn: number;
}

/** Output from a context.assemble contributor. Omitted fields are unchanged. */
export interface ContextAssemblyOutput {
	messages?: readonly unknown[];
	tools?: readonly ToolDefinition[];
	skip?: boolean;
	reply?: string;
	abort?: boolean;
}

/** A single stage in the context.assemble pipeline. */
export type ContextAssemblyHandler = (input: ContextAssemblyInput) => Promise<ContextAssemblyOutput>;

export type PortCardinality = "exactly-one" | "zero-or-one" | "zero-or-many" | "ordered-pipeline";

export interface PortDefinition {
	readonly name: string;
	readonly eventPattern: string;
	readonly cardinality: PortCardinality;
}

/**
 * Abstract theme for adapter TUI renderers.
 *
 * Uses semantic colour names so adapters are decoupled from ANSI/terminal specifics.
 * The runner provides a concrete implementation; a web renderer could provide CSS classes.
 * Defined in kernel so adapter packages can reference it without importing alef-tui.
 */
export interface AdapterTheme {
	/** Apply a semantic foreground colour to text. */
	fg(color: "accent" | "success" | "error" | "warning" | "muted" | "dim", text: string): string;
	/** Apply bold styling. */
	bold(text: string): string;
	/** Apply dim styling. */
	dim(text: string): string;
}

/** @deprecated Use AdapterTheme */
export type OrganTheme = AdapterTheme;

/**
 * TUI contribution — adapter-owned renderer for its tool calls and results.
 *
 * The TUI aggregator calls these when displaying tool events. Returning null
 * falls back to the default generic pill renderer.
 *
 * Components are imported from @dpopsuev/alef-tui. Using `unknown` here avoids
 * a kernel → alef-tui dependency; callers cast to Component at use-site.
 */
export interface TuiSignalSurface {
	setIntent(text: string): void;
	setStatus(text: string): void;
	setWidgetAbove(text: string): void;
}

export type TuiSignalHandler = (payload: Record<string, unknown>, ui: TuiSignalSurface) => void;

export interface TuiContribution {
	/** Render the in-progress tool call header (while waiting for result). */
	renderCall?(toolName: string, args: Record<string, unknown>, theme: AdapterTheme): unknown;
	/** Render the completed tool result. */
	renderResult?(
		toolName: string,
		result: Record<string, unknown>,
		opts: { expanded: boolean; isError: boolean },
		theme: AdapterTheme,
	): unknown;
	/**
	 * Render a nonCapturing overlay shown while the organ is active.
	 * Called once after organ mount; returned component is shown/hidden
	 * by the TUI aggregator as the organ runs.
	 */
	renderOverlay?(): unknown;
	/**
	 * Signal handlers for TUI updates. Keyed by signal type (e.g. "plan.checkpoint").
	 * The handler receives the signal payload and a minimal TUI surface.
	 * Collected at mount time — no TUI modification needed per organ.
	 */
	signals?: Readonly<Record<string, TuiSignalHandler>>;
}

/**
 * History contribution — declares which tools this organ owns for per-organ history indexing.
 */
export interface HistoryContribution {
	/** Tool names whose motor events should be indexed in this organ's history. */
	readonly ownedTools: readonly string[];
	/**
	 * Extract the fields worth storing from a motor event payload.
	 * Return null to skip this event.
	 */
	extractEntry(motorPayload: Record<string, unknown>): Record<string, unknown> | null;
}

/**
 * Plan scoping data passed to subagents for hierarchical delegation.
 * Contains a subgraph view of a parent plan rooted at a specific node.
 */
export interface PlanScopeData {
	/** ID of the parent plan this scope originated from */
	readonly parentPlanId: string;
	/** Node ID that serves as the root of this scoped view */
	readonly rootNodeId: string;
	/** Serialized subgraph nodes (includes root + all descendants) */
	readonly nodes: ReadonlyArray<{
		id: string;
		parent: string | null;
		label: string;
		status: "pending" | "active" | "done" | "pruned" | "deferred";
		depth: number;
		result?: string;
		feedback?: string;
	}>;
	/** Original plan metadata for context */
	readonly intention: string;
	readonly inception: { current: string; desired: string; delta: string } | null;
}

/**
 * Update event from a child scoped plan to its parent.
 * Published to sense bus when child modifies their scoped plan.
 */
export interface PlanUpdateEvent {
	/** Parent plan ID to update */
	readonly planId: string;
	/** Node ID being updated (full path from parent) */
	readonly nodeId: string;
	/** Update action: checkpoint, complete, expand, assess, refine */
	readonly action: "checkpoint" | "complete" | "expand" | "assess" | "refine";
	/** Additional payload based on action */
	readonly payload?: Record<string, unknown>;
}

/**
 * Plan scoping contribution for hierarchical multi-agent delegation.
 * Enables parent agents to delegate plan nodes to subagents with scoped plan views.
 */
export interface PlanScopeContribution {
	/**
	 * Extract a scoped plan view rooted at the given node.
	 * Returns null if no active plan or node doesn't exist.
	 */
	getScopedPlan(nodeId: string): Promise<PlanScopeData | null>;

	/**
	 * Apply an update from a child scoped plan to the parent plan.
	 * Called when a subagent modifies their scoped plan.
	 */
	applyChildUpdate(update: PlanUpdateEvent): Promise<void>;
}

export interface ReasoningContributions {
	readonly "agent.run"?: AgentRunContribution;
	readonly skills?: readonly SkillBook[];
}

export interface PipelineContributions {
	/** Contributes a stage to the context.assemble pipeline, run before each LLM call. */
	readonly "context.assemble"?: ContextAssemblyHandler;
	/** Provides full tool schemas for timeout calculation — populated by ToolShell. */
	readonly "schema-resolver"?: (toolName: string) => ToolDefinition | undefined;
}

export interface PresentationContributions {
	/** Organ-owned TUI renderers for tool calls and results. */
	readonly tui?: TuiContribution;
	/** Declares which tools this organ owns for per-organ history indexing. */
	readonly history?: HistoryContribution;
	/**
	 * Signal-to-display event mapping. Each key is a signal type (e.g. "workflow.step").
	 * The function maps the signal payload to a display event object, or null to skip.
	 * Collected by the runner at mount time — no hardcoded switch needed.
	 */
	readonly "signal.map"?: Readonly<
		Record<string, (payload: Record<string, unknown>) => Record<string, unknown> | null>
	>;
}

export interface SeamingContributions {
	/** Declares the seam this organ owns, validated at boot by the runtime. */
	readonly port?: PortDefinition;
	/** Plan scoping for hierarchical multi-agent delegation */
	readonly "plan.scope"?: PlanScopeContribution;
}

export interface AdapterContributions
	extends ReasoningContributions,
		PipelineContributions,
		PresentationContributions,
		SeamingContributions {}

/** @deprecated Use AdapterContributions */
export type OrganContributions = AdapterContributions;

export interface ToolDefinition {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: ZodTypeAny;
	readonly streaming?: true;
	/** Tool manages its own activity/stall detection. waitForToolResult uses a large timeout instead of the LLM default. */
	readonly longRunning?: true;
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
//   MotorEvent: commands flowing OUT from the Reasoner to organs (efferent).
//   SenseEvent: observations flowing IN from organs to the Reasoner (afferent).
//   SignalEvent: Reasoner internal telemetry broadcast to observers (cortical).
//               Never dispatched to organ handlers. Consumed by TUI, session-log,
//               router — NOT by EvaluatorOrgan or LoopGuard.
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
	readonly conditions?: readonly DomainCondition[];
}

/**
 * SignalEvent — Reasoner telemetry broadcast to observers.
 *
 * Published by organ-llm for streaming chunks, tool lifecycle notifications,
 * token usage, and other internal state that observers (TUI, session-log,
 * router) need to render but that is NOT a command to an organ.
 *
 * Examples: llm.chunk, llm.thinking, llm.tool-start, llm.tool-end,
 *           llm.token-usage, llm.turn-error, llm.result, llm.checkpoint,
 *           llm.message-queued.
 *
 * Never goes through dispatchMotorAction. No organ subscribes to it.
 * EvaluatorOrgan and LoopGuard subscribe to motor only — they never see signals.
 */
export interface SignalEvent extends NerveEvent {
	readonly type: string;
	readonly payload: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Nerve — unified view of all three buses.
//
// Every organ receives a Nerve. Direction is declared via the action-map key
// prefix in defineOrgan: "motor/" subscribes Motor, "sense/" subscribes Sense.
// The signal bus has no action-map prefix — only the Reasoner publishes to it
// and only observers (wildcard "*") subscribe to it.
// ---------------------------------------------------------------------------

export type MotorHandler = (event: MotorEvent) => void | Promise<void>;
export type SenseHandler = (event: SenseEvent) => void | Promise<void>;
export type SignalHandler = (event: SignalEvent) => void | Promise<void>;

/**
 * What organs pass to publish. The bus stamps timestamp and elapsed — organs
 * must not set them. Passing a timestamp is a compile-time error.
 */
export type MotorPublishInput = Omit<MotorEvent, "timestamp" | "elapsed">;
export type SensePublishInput = Omit<SenseEvent, "timestamp" | "elapsed">;
export type SignalPublishInput = Omit<SignalEvent, "timestamp" | "elapsed">;

export interface Nerve {
	readonly motor: {
		subscribe(type: string, handler: MotorHandler): () => void;
		publish(event: MotorPublishInput): void;
	};
	readonly sense: {
		subscribe(type: string, handler: SenseHandler): () => void;
		publish(event: SensePublishInput): void;
	};
	/** Signal bus — Reasoner telemetry only. Organs must not publish here. */
	readonly signal: {
		subscribe(type: string, handler: SignalHandler): () => void;
		publish(event: SignalPublishInput): void;
	};
	/** Reset the nerve-level liveness watchdog. Called automatically by organ-dispatch on every event. */
	pulse(): void;
}

/** A function that wraps a Nerve to intercept motor/sense events. Composable middleware. */
export type NerveMiddleware = (nerve: Nerve) => Nerve;

// ---------------------------------------------------------------------------
// Adapter — unified interface. mount(nerve: Nerve) handles both bus directions.
// ---------------------------------------------------------------------------

export interface Adapter {
	readonly name: string;
	readonly tools: readonly ToolDefinition[];
	mount(nerve: Nerve): () => void;
	close?(): Promise<void>;
	readonly subscriptions: {
		readonly motor: readonly string[];
		readonly sense: readonly string[];
	};
	readonly sources: readonly {
		readonly name: string;
		readonly kind: "file" | "memory" | "process";
	}[];
	readonly directives?: readonly string[];
	readonly contributions?: AdapterContributions;
	readonly description?: string;
	readonly labels?: readonly string[];
	readonly publishSchemas?: {
		readonly motor?: Readonly<Record<string, ZodTypeAny>>;
		readonly sense?: Readonly<Record<string, ZodTypeAny>>;
	};
	readonly inputSchemas?: {
		readonly motor?: Readonly<Record<string, ZodTypeAny>>;
	};
	ready?(): Promise<void>;
}

/** @deprecated Use Adapter */
export type Organ = Adapter;

// ---------------------------------------------------------------------------
// GimpedAdapter — explicit ablation primitive.
// ---------------------------------------------------------------------------

/**
 * Reasoner — kernel-level interface for the agent's reasoning component.
 *
 * A Reasoner is NOT an Adapter in the microkernel sense: it provides no tools,
 * does not respond to tool-call commands, and is not called by the LLM.
 * It is the component that CALLS adapters and drives the agent loop.
 */
export interface Reasoner extends Adapter {
	readonly tools: readonly [];
	readonly triggerEvent: string;
	readonly replyEvent: string;
}

export function isGimped(adapter: Adapter): boolean {
	return (
		adapter.tools.length === 0 && adapter.subscriptions.motor.length === 0 && adapter.subscriptions.sense.length === 0
	);
}

export function gimpedAdapter(name: string): Adapter {
	return {
		name,
		tools: [],
		subscriptions: { motor: [], sense: [] },
		sources: [],
		mount: () => () => {},
	};
}
/** @deprecated Use gimpedAdapter */
export const gimpedOrgan = gimpedAdapter;

// InProcessNerve exported from index.ts — not here, to avoid circular import with in-process-nerve.ts

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function newCorrelationId(): string {
	return randomUUID();
}
