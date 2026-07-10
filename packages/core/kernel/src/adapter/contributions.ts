import type { ZodRawShape } from "zod";
import type { Adapter, ToolDefinition } from "./interface.js";
import type { UiContribution, HistoryContribution } from "./ui.js";

/** Single instruction page within a skill book. */
export interface SkillPage {
	readonly name: string;
	readonly description: string;
	readonly instructions: string;
}

/** Named collection of skill pages contributed by an adapter. */
export interface SkillBook {
	readonly name: string;
	readonly description: string;
	readonly pages: readonly SkillPage[];
}

/** Mutable context provided to agent.run contributions for injecting instructions and adapters. */
export interface AgentRunContext {
	prependInstructions(text: string): void;
	addAdapters(adapters: Adapter[]): void;
}

/** Extension point allowing adapters to augment agent.run with extra arguments and setup. */
export interface AgentRunContribution {
	schema?: ZodRawShape;
	extend(args: Record<string, unknown>, context: AgentRunContext): Promise<void> | void;
}

/** Merge multiple adapter agent.run contributions into a single composite. */
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

/** Input snapshot passed to context assembly pipeline stages. */
export interface ContextAssemblyInput {
	readonly messages: readonly unknown[];
	readonly tools: readonly ToolDefinition[];
	readonly turn: number;
}

/** Result returned by a context assembly stage, optionally replacing messages, tools, or aborting. */
export interface ContextAssemblyOutput {
	messages?: readonly unknown[];
	tools?: readonly ToolDefinition[];
	skip?: boolean;
	reply?: string;
	abort?: boolean;
}

/** Async function that transforms context before it reaches the LLM. */
export type ContextAssemblyHandler = (input: ContextAssemblyInput) => Promise<ContextAssemblyOutput>;

/** Multiplicity constraint for an adapter port binding. */
export type PortCardinality = "exactly-one" | "zero-or-one" | "zero-or-many" | "ordered-pipeline";

/** Declares a named bus port with an event pattern and cardinality constraint. */
export interface PortDefinition {
	readonly name: string;
	readonly eventPattern: string;
	readonly cardinality: PortCardinality;
}

/** Read-only snapshot of a plan tree scoped to a specific step. */
export interface PlanScopeData {
	readonly parentPlanId: string;
	readonly rootStepId: string;
	readonly steps: ReadonlyArray<{
		id: string;
		parent: string | null;
		label: string;
		status: "pending" | "active" | "done" | "failed" | "dropped";
		depth: number;
		result?: string;
	}>;
	readonly current: string;
	readonly desired: string;
	readonly verify: string;
}

/** Event describing a mutation to a plan step. */
export interface PlanUpdateEvent {
	readonly planId: string;
	readonly stepId: string;
	readonly action: "start" | "done" | "fail" | "drop";
	readonly payload?: Record<string, unknown>;
}

/** Adapter contribution providing scoped plan access and child-update application. */
export interface PlanScopeContribution {
	getScopedPlan(nodeId: string): Promise<PlanScopeData | null>;
	applyChildUpdate(update: PlanUpdateEvent): Promise<void>;
}

/** Contribution slots related to LLM reasoning: agent.run extensions and skill books. */
export interface ReasoningContributions {
	readonly "agent.run"?: AgentRunContribution;
	readonly skills?: readonly SkillBook[];
}

/** Contribution slots for the context assembly pipeline, schema resolution, and event weighting. */
export interface ContextAssemblyContributions {
	readonly "context.assemble"?: ContextAssemblyHandler;
	readonly "schema-resolver"?: (toolName: string) => ToolDefinition | undefined;
	readonly "event.weights"?: Readonly<Record<string, number>>;
}

/** Contribution slots for TUI rendering, history extraction, and signal mapping. */
export interface PresentationContributions {
	readonly ui?: UiContribution;
	readonly history?: HistoryContribution;
	readonly "signal.map"?: Readonly<
		Record<string, (payload: Record<string, unknown>) => Record<string, unknown> | null>
	>;
}

/** Contribution slots for port declarations and plan-scope integration. */
export interface SeamingContributions {
	readonly port?: PortDefinition;
	readonly "plan.scope"?: PlanScopeContribution;
}

/** Union of all contribution slot categories an adapter may provide. */
export interface AdapterContributions
	extends ReasoningContributions,
		ContextAssemblyContributions,
		PresentationContributions,
		SeamingContributions {}
