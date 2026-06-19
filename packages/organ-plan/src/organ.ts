import { join } from "node:path";
import type { BaseOrganOptions, ContextAssemblyHandler, Organ } from "@dpopsuev/alef-kernel";
import { defineOrgan, injectContextBlock, typedAction, withDisplay } from "@dpopsuev/alef-kernel";
import { z } from "zod";
import { PlanGraph } from "./graph.js";

export interface PlanOrganOptions extends BaseOrganOptions {
	sessionDir: string;
}

function planPath(sessionDir: string): string {
	return join(sessionDir, "plan.json");
}

export function createPlanOrgan(opts: PlanOrganOptions): Organ {
	let activePlan: PlanGraph | null = null;
	let planSeq = 0;

	function ensureDisk(): string {
		return planPath(opts.sessionDir);
	}

	function loadOrCreate(): PlanGraph | null {
		if (activePlan) return activePlan;
		activePlan = PlanGraph.load(ensureDisk());
		return activePlan;
	}

	const contextStage: ContextAssemblyHandler = async (input) => {
		const plan = loadOrCreate();
		if (!plan || plan.phase === "closed") return {};
		const summary = plan.renderSummary();
		return { messages: injectContextBlock(input.messages, `[Plan — ${plan.phase}]\n${summary}`) };
	};

	return defineOrgan(
		"plan",
		{
			motor: {
				"plan.begin": typedAction(
					{
						name: "plan.begin",
						description: "Start a new plan. Sets the intention and enters the ideation block.",
						inputSchema: z.object({ intention: z.string().min(1) }),
					},
					async (ctx) => {
						const id = `plan-${++planSeq}`;
						activePlan = new PlanGraph(id, ctx.payload.intention, ensureDisk());
						return withDisplay(
							{ id, phase: "intention" },
							{ text: `Plan ${id} started: ${ctx.payload.intention}`, mimeType: "text/plain" },
						);
					},
				),

				"plan.state": typedAction(
					{
						name: "plan.state",
						description: "Set current and desired state (inception phase).",
						inputSchema: z.object({
							current: z.string().min(1),
							desired: z.string().min(1),
							delta: z.string().min(1).describe("What needs to change"),
						}),
					},
					async (ctx) => {
						const plan = loadOrCreate();
						if (!plan)
							return withDisplay(
								{ error: "no plan" },
								{ text: "No active plan. Use plan.begin first.", mimeType: "text/plain" },
							);
						plan.setInception(ctx.payload.current, ctx.payload.desired, ctx.payload.delta);
						return withDisplay(
							{ phase: plan.phase },
							{ text: `State set. Phase: ${plan.phase}`, mimeType: "text/plain" },
						);
					},
				),

				"plan.exclude": typedAction(
					{
						name: "plan.exclude",
						description: "Add exclusions — what's out of scope (contraction phase).",
						inputSchema: z.object({ items: z.array(z.string().min(1)).min(1) }),
					},
					async (ctx) => {
						const plan = loadOrCreate();
						if (!plan)
							return withDisplay({ error: "no plan" }, { text: "No active plan.", mimeType: "text/plain" });
						for (const item of ctx.payload.items) plan.addExclusion(item);
						return withDisplay(
							{ exclusions: ctx.payload.items.length },
							{ text: `${ctx.payload.items.length} exclusion(s) added`, mimeType: "text/plain" },
						);
					},
				),

				"plan.fix": typedAction(
					{
						name: "plan.fix",
						description: "Define the singular end state — what 'done' looks like (fixation phase).",
						inputSchema: z.object({ endState: z.string().min(1) }),
					},
					async (ctx) => {
						const plan = loadOrCreate();
						if (!plan)
							return withDisplay({ error: "no plan" }, { text: "No active plan.", mimeType: "text/plain" });
						plan.setEndState(ctx.payload.endState);
						return withDisplay(
							{ phase: plan.phase },
							{ text: `End state fixed: ${ctx.payload.endState}`, mimeType: "text/plain" },
						);
					},
				),

				"plan.expand": typedAction(
					{
						name: "plan.expand",
						description: "Add nodes to the navigation graph (expansion phase). Each node represents work to do.",
						inputSchema: z.object({
							nodes: z
								.array(
									z.object({
										label: z.string().min(1),
										parent: z.string().optional().describe("Parent node ID (e.g. 'n0'). Omit for root node."),
									}),
								)
								.min(1),
						}),
					},
					async (ctx) => {
						const plan = loadOrCreate();
						if (!plan)
							return withDisplay({ error: "no plan" }, { text: "No active plan.", mimeType: "text/plain" });
						const created = ctx.payload.nodes.map((n) => plan.addNode(n.label, n.parent ?? null));
						return withDisplay(
							{ added: created.length, ids: created.map((n) => n.id) },
							{
								text: `Added ${created.length} node(s): ${created.map((n) => `${n.id}:${n.label}`).join(", ")}`,
								mimeType: "text/plain",
							},
						);
					},
				),

				"plan.reduce": typedAction(
					{
						name: "plan.reduce",
						description: "Prune unnecessary nodes from the plan (reduction phase).",
						inputSchema: z.object({ prune: z.array(z.string().min(1)).min(1).describe("Node IDs to prune") }),
					},
					async (ctx) => {
						const plan = loadOrCreate();
						if (!plan)
							return withDisplay({ error: "no plan" }, { text: "No active plan.", mimeType: "text/plain" });
						let pruned = 0;
						for (const id of ctx.payload.prune) {
							if (plan.pruneNode(id)) pruned++;
						}
						return withDisplay({ pruned }, { text: `Pruned ${pruned} node(s)`, mimeType: "text/plain" });
					},
				),

				"plan.consolidate": typedAction(
					{
						name: "plan.consolidate",
						description: "Mark the plan as consolidated — ready for implementation. Optionally defer nodes.",
						inputSchema: z.object({
							defer: z.array(z.string()).optional().describe("Node IDs to defer to later"),
						}),
					},
					async (ctx) => {
						const plan = loadOrCreate();
						if (!plan)
							return withDisplay({ error: "no plan" }, { text: "No active plan.", mimeType: "text/plain" });
						for (const id of ctx.payload.defer ?? []) plan.deferNode(id);
						plan.advanceTo("consolidation");
						return withDisplay(
							{ phase: plan.phase, stats: plan.stats() },
							{ text: `Plan consolidated.\n${plan.renderTree()}`, mimeType: "text/plain" },
						);
					},
				),

				"plan.checkpoint": typedAction(
					{
						name: "plan.checkpoint",
						description: "Mark a plan node as in-progress (implementation phase).",
						inputSchema: z.object({ nodeId: z.string().min(1) }),
					},
					async (ctx) => {
						const plan = loadOrCreate();
						if (!plan)
							return withDisplay({ error: "no plan" }, { text: "No active plan.", mimeType: "text/plain" });
						plan.checkpoint(ctx.payload.nodeId);
						return withDisplay(
							{ nodeId: ctx.payload.nodeId, phase: plan.phase },
							{ text: `Node ${ctx.payload.nodeId} is now active`, mimeType: "text/plain" },
						);
					},
				),

				"plan.assess": typedAction(
					{
						name: "plan.assess",
						description: "Record the result of implementing a node — compare execution to intent.",
						inputSchema: z.object({
							nodeId: z.string().min(1),
							result: z.string().min(1).describe("What was the outcome?"),
						}),
					},
					async (ctx) => {
						const plan = loadOrCreate();
						if (!plan)
							return withDisplay({ error: "no plan" }, { text: "No active plan.", mimeType: "text/plain" });
						plan.assess(ctx.payload.nodeId, ctx.payload.result);
						return withDisplay(
							{ nodeId: ctx.payload.nodeId },
							{ text: `Assessment recorded for ${ctx.payload.nodeId}`, mimeType: "text/plain" },
						);
					},
				),

				"plan.refine": typedAction(
					{
						name: "plan.refine",
						description: "Send a node back for rework with feedback.",
						inputSchema: z.object({
							nodeId: z.string().min(1),
							feedback: z.string().min(1),
						}),
					},
					async (ctx) => {
						const plan = loadOrCreate();
						if (!plan)
							return withDisplay({ error: "no plan" }, { text: "No active plan.", mimeType: "text/plain" });
						plan.refine(ctx.payload.nodeId, ctx.payload.feedback);
						return withDisplay(
							{ nodeId: ctx.payload.nodeId },
							{ text: `Node ${ctx.payload.nodeId} sent back: ${ctx.payload.feedback}`, mimeType: "text/plain" },
						);
					},
				),

				"plan.complete": typedAction(
					{
						name: "plan.complete",
						description: "Mark a node as done.",
						inputSchema: z.object({ nodeId: z.string().min(1) }),
					},
					async (ctx) => {
						const plan = loadOrCreate();
						if (!plan)
							return withDisplay({ error: "no plan" }, { text: "No active plan.", mimeType: "text/plain" });
						plan.completeNode(ctx.payload.nodeId);
						const s = plan.stats();
						return withDisplay(
							{ nodeId: ctx.payload.nodeId, stats: s },
							{
								text: `Node ${ctx.payload.nodeId} done. Progress: ${s.done}/${s.total}`,
								mimeType: "text/plain",
							},
						);
					},
				),

				"plan.close": typedAction(
					{
						name: "plan.close",
						description: "Close the plan with an after-action review (introspection phase).",
						inputSchema: z.object({
							aar: z.string().min(1).describe("After-action review: what worked, what didn't, what to improve"),
						}),
					},
					async (ctx) => {
						const plan = loadOrCreate();
						if (!plan)
							return withDisplay({ error: "no plan" }, { text: "No active plan.", mimeType: "text/plain" });
						plan.setAAR(ctx.payload.aar);
						plan.close();
						const summary = plan.renderSummary();
						activePlan = null;
						return withDisplay({ closed: true }, { text: `Plan closed.\n${summary}`, mimeType: "text/plain" });
					},
				),

				"plan.show": typedAction(
					{
						name: "plan.show",
						description: "Show the current plan state, phase, and navigation tree.",
						inputSchema: z.object({}),
					},
					async () => {
						const plan = loadOrCreate();
						if (!plan)
							return withDisplay(
								{ active: false },
								{ text: "No active plan. Use plan.begin to start.", mimeType: "text/plain" },
							);
						return withDisplay(plan.toJSON() as unknown as Record<string, unknown>, {
							text: plan.renderSummary(),
							mimeType: "text/plain",
						});
					},
				),
			},
		},
		{
			description: "Phased planning tool — 11-phase structured lifecycle from intention to introspection.",
			directives: [
				"Use plan.begin to start a plan. Follow the phases: intention → inception → contraction → fixation → expansion → reduction → consolidation → implementation → assessment → refinement → introspection.",
				"The plan is injected into your context automatically. Use plan.show to see the current state.",
			],
			sources: [{ name: "plan-file", kind: "file" }],
			contributions: { "context.assemble": contextStage },
			...opts,
		},
	);
}
