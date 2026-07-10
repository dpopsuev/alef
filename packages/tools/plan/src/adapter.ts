import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Adapter, BaseAdapterOptions, CommandHandlerCtx } from "@dpopsuev/alef-kernel/adapter";
import { defineAdapter, typedAction } from "@dpopsuev/alef-kernel/adapter";
import { withDisplay } from "@dpopsuev/alef-kernel/payload";
import type { Bus } from "@dpopsuev/alef-kernel/bus";
import type { ContextAssemblyHandler } from "@dpopsuev/alef-kernel/context-assembly";
import { injectContextBlock } from "@dpopsuev/alef-kernel/context-assembly";
import { z } from "zod";
import { PlanGraph } from "./graph.js";

const SHORT_ID_LENGTH = 12;

const PLAN_OPEN = {
	name: "plan.open",
	description: "Open a plan: define current state, desired state, and verification criteria.",
	inputSchema: z.object({
		current: z.string().min(1).describe("Where we are now — observable facts"),
		desired: z.string().min(1).describe("Where we want to be — measurable end state"),
		verify: z.string().min(1).describe("How we know we are done — acceptance criteria"),
	}),
};

const gateSchema = z.object({
	type: z.enum(["file-exists", "command", "contains", "test"]),
	target: z.string().min(1).describe("File path, shell command, or test pattern"),
	expect: z.string().optional().describe("Expected content for 'contains' or 'command' gates"),
});

const inspectorSchema = z.object({
	type: z.string().min(1).describe("Inspector type (e.g. functional, structural, security)"),
	prompt: z.string().min(1).describe("What the inspector should evaluate for this step"),
});

const PLAN_STEPS = {
	name: "plan.steps",
	description: "Add steps to the plan. Each step is a desired state guarded by optional assertion gates and an inspector.",
	inputSchema: z.object({
		steps: z.array(z.object({
			label: z.string().min(10).max(80).describe("Step desired state: 3-12 words"),
			dependsOn: z.array(z.string()).optional().describe("Step IDs this step depends on. Omit for root steps."),
			gates: z.array(gateSchema).optional().describe("Deterministic assertions that must pass on completion"),
			inspector: inspectorSchema.optional().describe("LLM inspector assigned at planning time"),
		})).min(1),
	}),
};

const PLAN_ADVANCE = {
	name: "plan.advance",
	description: "Advance a step: start, complete (runs gates), fail, or drop. Returns the next ready step.",
	inputSchema: z.object({
		stepId: z.string().min(1).describe("Step ID (slugified label)"),
		action: z.enum(["start", "done", "fail", "drop"]),
		result: z.string().optional().describe("Outcome description (required for done/fail)"),
	}),
};

const PLAN_AMEND = {
	name: "plan.amend",
	description: "Update the plan's state definition mid-flight.",
	inputSchema: z.object({
		current: z.string().optional().describe("Updated current state"),
		desired: z.string().optional().describe("Updated desired state"),
		verify: z.string().optional().describe("Updated verification criteria"),
	}),
};

const PLAN_SHOW = {
	name: "plan.show",
	description: "Show current plan state, step tree, progress, and next ready step.",
	inputSchema: z.object({}),
};

const PLAN_CLOSE = {
	name: "plan.close",
	description: "Close the plan with a summary of what was accomplished.",
	inputSchema: z.object({
		summary: z.string().min(1).describe("What was accomplished"),
	}),
};

/** Options for the plan adapter, extending base with a session directory. */
export interface PlanAdapterOptions extends BaseAdapterOptions {
	sessionDir: string;
	actorAddress?: string;
}

/** Return the on-disk path for the plan JSON file. */
function planPath(sessionDir: string): string {
	return join(sessionDir, "plan.json");
}

/** Create the plan adapter with step management, gate evaluation, and context injection. */
export function createPlanAdapter(opts: PlanAdapterOptions): Adapter {
	let activePlan: PlanGraph | null = null;
	let mountedBus: Bus | null = null;

	/** Publish a bus notification with the given type and payload. */
	function emit(type: string, payload: Record<string, unknown>): void {
		mountedBus?.notification.publish({ type, payload, correlationId: "" });
	}

	/** Auto-post a typed record to discourse for audit trail. */
	function postToDiscourse(planId: string, thread: string, content: Record<string, unknown>): void {
		mountedBus?.command.publish({
			type: "discourse.post",
			correlationId: "",
			payload: { topic: "plan", thread: planId, content, author: opts.actorAddress ?? "plan-adapter" },
		});
	}

	/** Load the active plan from disk or return the cached instance. */
	function loadOrCreate(): PlanGraph | null {
		if (activePlan) return activePlan;
		activePlan = PlanGraph.load(planPath(opts.sessionDir));
		return activePlan;
	}

	// eslint-disable-next-line @typescript-eslint/require-await
	const contextStage: ContextAssemblyHandler = async (input) => {
		const plan = loadOrCreate();
		if (!plan || plan.phase === "closed") return {};
		return { messages: injectContextBlock(input.messages, plan.renderSummary()) };
	};

	/** Handle plan.open: create a new plan with current/desired/verify state. */
	// eslint-disable-next-line @typescript-eslint/require-await
	async function handleOpen(ctx: CommandHandlerCtx<z.infer<typeof PLAN_OPEN.inputSchema>>): Promise<Record<string, unknown>> {
		const id = `plan-${randomUUID().replace(/-/g, "").slice(0, SHORT_ID_LENGTH)}`;
		activePlan = new PlanGraph(id, ctx.payload.current, ctx.payload.desired, ctx.payload.verify, planPath(opts.sessionDir));
		emit("plan.opened", { planId: id });
		postToDiscourse(id, id, { type: "plan:opened", current: ctx.payload.current, desired: ctx.payload.desired, verify: ctx.payload.verify });
		return withDisplay({ id, phase: "open" }, { text: `Plan ${id} opened.\nCurrent: ${ctx.payload.current}\nDesired: ${ctx.payload.desired}\nVerify: ${ctx.payload.verify}`, mimeType: "text/plain" });
	}

	/** Handle plan.steps: add steps with gates and inspectors to the active plan. */
	// eslint-disable-next-line @typescript-eslint/require-await
	async function handleSteps(ctx: CommandHandlerCtx<z.infer<typeof PLAN_STEPS.inputSchema>>): Promise<Record<string, unknown>> {
		const plan = loadOrCreate();
		if (!plan) return withDisplay({ error: "no plan" }, { text: "No active plan. Use plan.open first.", mimeType: "text/plain" });

		const created = ctx.payload.steps.map((s) =>
			plan.addStep(s.label, s.dependsOn ?? [], s.gates ?? [], s.inspector),
		);
		return withDisplay(
			{ added: created.length, ids: created.map((s) => s.id) },
			{ text: `Added ${created.length} step(s): ${created.map((s) => s.id).join(", ")}`, mimeType: "text/plain" },
		);
	}

	/** Handle plan.advance: transition a step (start, done, fail, drop) and return next ready. */
	// eslint-disable-next-line @typescript-eslint/require-await
	async function handleAdvance(ctx: CommandHandlerCtx<z.infer<typeof PLAN_ADVANCE.inputSchema>>): Promise<Record<string, unknown>> {
		const plan = loadOrCreate();
		if (!plan) return withDisplay({ error: "no plan" }, { text: "No active plan.", mimeType: "text/plain" });

		const { stepId, action, result } = ctx.payload;

		switch (action) {
			case "start": {
				const step = plan.startStep(stepId);
				if (!step) return withDisplay({ error: "cannot start" }, { text: `Cannot start ${stepId}`, mimeType: "text/plain" });
				emit("step.started", { planId: plan.id, stepId, label: step.label });
				postToDiscourse(plan.id, plan.id, { type: "step:started", stepId, label: step.label });
				emit("plan.intent", { text: step.label });
				emit("plan.tree", { tree: plan.renderTree() });
				const next = plan.nextReady();
				return withDisplay({ stepId, status: "active", next: next?.id ?? null }, { text: `Started: ${step.label}`, mimeType: "text/plain" });
			}
			case "done": {
				const outcome = plan.completeStep(stepId, result);
				if (!outcome) return withDisplay({ error: "cannot complete" }, { text: `Cannot complete ${stepId}`, mimeType: "text/plain" });
				const { step, gateResults } = outcome;
				if (step.status === "done") {
					const s = plan.stats();
					emit("step.completed", { planId: plan.id, stepId, result: step.result });
					postToDiscourse(plan.id, plan.id, { type: "step:completed", stepId, result: step.result, progress: s });
					const next = plan.nextReady();
					emit("plan.tree", { tree: plan.renderTree() });
					if (!next) emit("plan.intent", { text: "" });
					return withDisplay(
						{ stepId, status: "done", gateResults, progress: s, next: next?.id ?? null, inspector: step.inspector ?? null },
						{ text: `Done: ${step.label} (${s.done}/${s.total}). Next: ${next?.id ?? "none"}`, mimeType: "text/plain" },
					);
				}
				emit("step.failed", { planId: plan.id, stepId, gateResults });
				const failedGates = gateResults.filter((g) => !g.passed).map((g) => `${g.gate.type}:${g.gate.target} — ${g.output}`);
				postToDiscourse(plan.id, plan.id, { type: "step:failed", stepId, failedGates });
				return withDisplay(
					{ stepId, status: "failed", gateResults, failedGates },
					{ text: `Gates failed for ${stepId}:\n${failedGates.join("\n")}`, mimeType: "text/plain" },
				);
			}
			case "fail": {
				const step = plan.failStep(stepId, result ?? "failed");
				if (!step) return withDisplay({ error: "cannot fail" }, { text: `Cannot fail ${stepId}`, mimeType: "text/plain" });
				emit("step.failed", { planId: plan.id, stepId, reason: result });
				postToDiscourse(plan.id, plan.id, { type: "step:failed", stepId, reason: result ?? "failed" });
				return withDisplay({ stepId, status: "failed" }, { text: `Failed: ${step.label} — ${result ?? "no reason"}`, mimeType: "text/plain" });
			}
			case "drop": {
				const step = plan.dropStep(stepId);
				if (!step) return withDisplay({ error: "cannot drop" }, { text: `Cannot drop ${stepId}`, mimeType: "text/plain" });
				emit("plan.tree", { tree: plan.renderTree() });
				return withDisplay({ stepId, status: "dropped" }, { text: `Dropped: ${step.label}`, mimeType: "text/plain" });
			}
			default:
				return withDisplay({ error: "unknown action" }, { text: `Unknown action: ${action as string}`, mimeType: "text/plain" });
		}
	}

	/** Handle plan.amend: update the plan's current/desired/verify state mid-flight. */
	// eslint-disable-next-line @typescript-eslint/require-await
	async function handleAmend(ctx: CommandHandlerCtx<z.infer<typeof PLAN_AMEND.inputSchema>>): Promise<Record<string, unknown>> {
		const plan = loadOrCreate();
		if (!plan) return withDisplay({ error: "no plan" }, { text: "No active plan.", mimeType: "text/plain" });
		plan.amend(ctx.payload);
		return withDisplay({ amended: true }, { text: "Plan amended.", mimeType: "text/plain" });
	}

	/** Handle plan.show: render the current plan state and step tree. */
	// eslint-disable-next-line @typescript-eslint/require-await
	async function handleShow(): Promise<Record<string, unknown>> {
		const plan = loadOrCreate();
		if (!plan) return withDisplay({ active: false }, { text: "No active plan. Use plan.open to start.", mimeType: "text/plain" });
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- PlanData is a plain object
		return withDisplay(plan.toJSON() as unknown as Record<string, unknown>, { text: plan.renderSummary(), mimeType: "text/plain" });
	}

	/** Handle plan.close: close the plan with a summary. */
	// eslint-disable-next-line @typescript-eslint/require-await
	async function handleClose(ctx: CommandHandlerCtx<z.infer<typeof PLAN_CLOSE.inputSchema>>): Promise<Record<string, unknown>> {
		const plan = loadOrCreate();
		if (!plan) return withDisplay({ error: "no plan" }, { text: "No active plan.", mimeType: "text/plain" });
		plan.close(ctx.payload.summary);
		emit("plan.closed", { planId: plan.id, summary: ctx.payload.summary });
		postToDiscourse(plan.id, plan.id, { type: "plan:closed", summary: ctx.payload.summary, stats: plan.stats() });
		emit("plan.intent", { text: "" });
		emit("plan.tree", { tree: "" });
		const summary = plan.renderSummary();
		activePlan = null;
		return withDisplay({ closed: true }, { text: `Plan closed.\n${summary}`, mimeType: "text/plain" });
	}

	return defineAdapter(
		"plan",
		{
			command: {
				"plan.open": typedAction(PLAN_OPEN, handleOpen),
				"plan.steps": typedAction(PLAN_STEPS, handleSteps),
				"plan.advance": typedAction(PLAN_ADVANCE, handleAdvance),
				"plan.amend": typedAction(PLAN_AMEND, handleAmend),
				"plan.show": typedAction(PLAN_SHOW, handleShow),
				"plan.close": typedAction(PLAN_CLOSE, handleClose),
			},
		},
		{
			description: "Plan — define current→desired state, break into steps, verify each transition.",
			labels: ["plan", "reasoning"],
			directives: [
				"Use plan.open to define where you are and where you want to be.",
				"Use plan.steps to break the work into verifiable steps. Each step is a desired state.",
				"Use plan.advance to start, complete, fail, or drop steps. Gates run automatically on completion.",
				"The plan state is injected into your context automatically. Follow the 'Next:' step.",
				"Autopilot loop: plan.advance(start) → do the work → plan.advance(done) → follow the next step. Repeat until all steps done, then plan.close.",
				"If gates fail on completion, the step status becomes 'failed'. Fix the issue and call plan.advance(start) to retry.",
				"Steps with dependsOn wait for ALL dependencies to complete before becoming eligible.",
			],
			sources: [{ name: "plan-file", kind: "file" }],
			onMount: (bus: Bus) => {
				mountedBus = bus;
				bus.notification.subscribe("llm.turn-error", (event) => {
					const plan = loadOrCreate();
					if (!plan || plan.phase !== "working") return;
					const active = plan.toJSON().steps.find((s) => s.status === "active");
					if (!active) return;
					const payload = event.payload;
					const msg = typeof payload.message === "string" ? payload.message : "LLM error";
					postToDiscourse(plan.id, plan.id, { type: "step:error", stepId: active.id, error: msg });
				});
			},
			contributions: {
				"context.assemble": contextStage,
				ui: {
					signals: {
						"plan.intent": (payload, ui) => {
							ui.setIntent(typeof payload.text === "string" ? payload.text : "");
						},
						"plan.tree": (payload, ui) => {
							ui.setWidgetAbove(typeof payload.tree === "string" ? payload.tree : "");
						},
					},
				},
			},
			...opts,
		},
	);
}
