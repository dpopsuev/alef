import type { ZodRawShape } from "zod";
import type { Adapter, ToolDefinition } from "./adapter-interface.js";
import type { UiContribution, HistoryContribution } from "./ui-types.js";

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

export interface ContextAssemblyInput {
	readonly messages: readonly unknown[];
	readonly tools: readonly ToolDefinition[];
	readonly turn: number;
}

export interface ContextAssemblyOutput {
	messages?: readonly unknown[];
	tools?: readonly ToolDefinition[];
	skip?: boolean;
	reply?: string;
	abort?: boolean;
}

export type ContextAssemblyHandler = (input: ContextAssemblyInput) => Promise<ContextAssemblyOutput>;

export type PortCardinality = "exactly-one" | "zero-or-one" | "zero-or-many" | "ordered-pipeline";

export interface PortDefinition {
	readonly name: string;
	readonly eventPattern: string;
	readonly cardinality: PortCardinality;
}

export interface PlanScopeData {
	readonly parentPlanId: string;
	readonly rootNodeId: string;
	readonly nodes: ReadonlyArray<{
		id: string;
		parent: string | null;
		label: string;
		status: "pending" | "active" | "done" | "pruned" | "deferred";
		depth: number;
		result?: string;
		feedback?: string;
	}>;
	readonly intention: string;
	readonly inception: { current: string; desired: string; delta: string } | null;
}

export interface PlanUpdateEvent {
	readonly planId: string;
	readonly nodeId: string;
	readonly action: "checkpoint" | "complete" | "expand" | "assess" | "refine";
	readonly payload?: Record<string, unknown>;
}

export interface PlanScopeContribution {
	getScopedPlan(nodeId: string): Promise<PlanScopeData | null>;
	applyChildUpdate(update: PlanUpdateEvent): Promise<void>;
}

export interface ReasoningContributions {
	readonly "agent.run"?: AgentRunContribution;
	readonly skills?: readonly SkillBook[];
}

export interface PipelineContributions {
	readonly "context.assemble"?: ContextAssemblyHandler;
	readonly "schema-resolver"?: (toolName: string) => ToolDefinition | undefined;
}

export interface PresentationContributions {
	readonly ui?: UiContribution;
	readonly history?: HistoryContribution;
	readonly "signal.map"?: Readonly<
		Record<string, (payload: Record<string, unknown>) => Record<string, unknown> | null>
	>;
}

export interface SeamingContributions {
	readonly port?: PortDefinition;
	readonly "plan.scope"?: PlanScopeContribution;
}

export interface AdapterContributions
	extends ReasoningContributions,
		PipelineContributions,
		PresentationContributions,
		SeamingContributions {}
