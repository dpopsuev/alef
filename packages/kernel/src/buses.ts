import { randomUUID } from "node:crypto";
import { type ZodRawShape, type ZodTypeAny, z } from "zod";
import type { DomainCondition } from "./reconciliation.js";

export interface BusMessage {
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
 * Use this in adapters (e.g. McpAdapter) where the schema arrives as JSON Schema at runtime
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

export interface CommandMessage extends BusMessage {
	readonly type: string;
	readonly payload: Record<string, unknown>;
}

export interface EventMessage extends BusMessage {
	readonly type: string;
	readonly payload: Record<string, unknown>;
	readonly isError: boolean;
	readonly errorMessage?: string;
	readonly conditions?: readonly DomainCondition[];
}

export interface NotificationMessage extends BusMessage {
	readonly type: string;
	readonly payload: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Bus — unified view of all three channels.
//
// Every adapter receives a Bus. Direction is declared via the action-map key
// prefix in defineAdapter: "command/" subscribes Command, "event/" subscribes Event.
// The notification channel has no action-map prefix — only the Reasoner publishes to it
// and only observers (wildcard "*") subscribe to it.
// ---------------------------------------------------------------------------

export type CommandHandler = (event: CommandMessage) => void | Promise<void>;
export type EventHandler = (event: EventMessage) => void | Promise<void>;
export type NotificationHandler = (event: NotificationMessage) => void | Promise<void>;

export type CommandInput = Omit<CommandMessage, "timestamp" | "elapsed">;
export type EventInput = Omit<EventMessage, "timestamp" | "elapsed">;
export type NotificationInput = Omit<NotificationMessage, "timestamp" | "elapsed">;

export type ChannelName = "command" | "event" | "notification";

export type ChannelMap<T> = { readonly [K in ChannelName]: T };

export interface ChannelMessages {
	command: CommandMessage;
	event: EventMessage;
	notification: NotificationMessage;
}

export type ChannelHandler<K extends ChannelName> = (event: ChannelMessages[K]) => void | Promise<void>;
export type ChannelInput<K extends ChannelName> = Omit<ChannelMessages[K], "timestamp" | "elapsed">;

export interface BusChannel<K extends ChannelName = ChannelName> {
	subscribe(type: string, handler: ChannelHandler<K>): () => void;
	publish(event: ChannelInput<K>): void;
}

export type Bus = { readonly [K in ChannelName]: BusChannel<K> } & { pulse(): void };

export type BusMiddleware = (bus: Bus) => Bus;

// ---------------------------------------------------------------------------
// Adapter — unified interface. mount(bus: Bus) handles both bus directions.
// ---------------------------------------------------------------------------

export interface Adapter {
	readonly name: string;
	readonly tools: readonly ToolDefinition[];
	mount(bus: Bus): () => void;
	close?(): Promise<void>;
	readonly subscriptions: {
		readonly command: readonly string[];
		readonly event: readonly string[];
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
		readonly command?: Readonly<Record<string, ZodTypeAny>>;
		readonly event?: Readonly<Record<string, ZodTypeAny>>;
	};
	readonly inputSchemas?: {
		readonly command?: Readonly<Record<string, ZodTypeAny>>;
	};
	ready?(): Promise<void>;
}

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
		adapter.tools.length === 0 &&
		adapter.subscriptions.command.length === 0 &&
		adapter.subscriptions.event.length === 0
	);
}

export function gimpedAdapter(name: string): Adapter {
	return {
		name,
		tools: [],
		subscriptions: { command: [], event: [] },
		sources: [],
		mount: () => () => {},
	};
}

/**
 * Build a Bus from individual channels, populating both canonical (command/event/notification)
 * and deprecated (motor/sense/signal) properties. Use when constructing a wrapped Bus inline.
 */
export function makeBus(
	command: BusChannel<"command">,
	event: BusChannel<"event">,
	notification: BusChannel<"notification">,
	pulse: () => void,
): Bus {
	return { command, event, notification, pulse };
}

// InProcessNerve exported from index.ts — not here, to avoid circular import with in-process-nerve.ts

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function newCorrelationId(): string {
	return randomUUID();
}
