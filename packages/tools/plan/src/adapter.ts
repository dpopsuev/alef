import type { Adapter, BaseAdapterOptions, CommandHandlerCtx } from "@dpopsuev/alef-kernel/adapter";
import { defineAdapter, typedAction } from "@dpopsuev/alef-kernel/adapter";
import type { Bus } from "@dpopsuev/alef-kernel/bus";
import type { ContextAssemblyHandler } from "@dpopsuev/alef-kernel/context-assembly";
import { injectContextBlock } from "@dpopsuev/alef-kernel/context-assembly";
import { withDisplay } from "@dpopsuev/alef-kernel/payload";
import { z } from "zod";
import type { PlanGraph } from "./graph.js";
import { PlanStore } from "./store.js";

const PLAN_OPEN = {
	name: "plan.open",
	description: "Open a plan (current → desired → verify). Previous focused plan is backlogged.",
	inputSchema: z.object({
		current: z.string().min(1).describe("Current state"),
		desired: z.string().min(1).describe("Desired state"),
		verify: z.string().min(1).describe("Acceptance criteria"),
	}),
};

const gateSchema = z.object({
	type: z.enum(["file-exists", "command", "contains", "test"]),
	target: z.string().min(1).describe("File path, command, or pattern"),
	expect: z.string().optional().describe("Expected content for contains/command"),
});

const inspectorSchema = z.object({
	type: z.string().min(1).describe("Inspector type"),
	prompt: z.string().min(1).describe("What to evaluate"),
});

const PLAN_STEPS = {
	name: "plan.steps",
	description: "Add steps (desired state + optional gates/inspector).",
	inputSchema: z.object({
		steps: z.array(z.object({
			label: z.string().min(10).max(80).describe("Step desired state: 3-12 words"),
			dependsOn: z.array(z.string()).optional().describe("Step IDs this depends on"),
			gates: z.array(gateSchema).optional().describe("Assertions that must pass on completion"),
			inspector: inspectorSchema.optional().describe("LLM inspector for this step"),
		})).min(1),
	}),
};

const PLAN_ADVANCE = {
	name: "plan.advance",
	description: "Advance a step: claim, release, heartbeat, start, done, fail, or drop.",
	inputSchema: z.object({
		stepId: z.string().min(1).describe("Step ID"),
		action: z.enum(["claim", "release", "heartbeat", "start", "done", "fail", "drop"]),
		owner: z.string().optional().describe("Owner address for claim actions."),
		token: z.string().optional().describe("Claim token required for claimed-step transitions."),
		leaseMs: z.number().optional().describe("Lease extension in ms for claim/heartbeat."),
		note: z.string().optional().describe("Optional reservation note."),
		result: z.string().optional().describe("Outcome (required for done/fail)"),
	}),
};

const PLAN_AMEND = {
	name: "plan.amend",
	description: "Update plan current/desired/verify mid-flight.",
	inputSchema: z.object({
		current: z.string().optional().describe("Updated current state"),
		desired: z.string().optional().describe("Updated desired state"),
		verify: z.string().optional().describe("Updated verification"),
	}),
};

const PLAN_SHOW = {
	name: "plan.show",
	description: "Show focused plan state and next ready step.",
	inputSchema: z.object({}),
};

const PLAN_LIST = {
	name: "plan.list",
	description: "List workspace plans (active, backlog, closed).",
	inputSchema: z.object({
		status: z.enum(["active", "backlog", "closed"]).optional().describe("Status filter"),
	}),
};

const PLAN_FOCUS = {
	name: "plan.focus",
	description: "Focus a plan by id; previous focused plan is backlogged.",
	inputSchema: z.object({
		id: z.string().min(1).describe("Plan id"),
	}),
};

const PLAN_BACKLOG = {
	name: "plan.backlog",
	description: "Demote the focused plan to backlog without closing it.",
	inputSchema: z.object({
		id: z.string().optional().describe("Plan id (defaults to focused)"),
	}),
};

const PLAN_CLOSE = {
	name: "plan.close",
	description: "Close the focused plan with a summary.",
	inputSchema: z.object({
		summary: z.string().min(1).describe("What was accomplished"),
	}),
};

/** Options for the plan adapter — workspace-scoped multi-plan shelf. */
export interface PlanAdapterOptions extends BaseAdapterOptions {
	/** Workspace cwd (plans keyed by this). */
	cwd: string;
	/** Override plans root for tests. Default: $XDG_DATA_HOME/alef/plans/<cwd-hash> */
	plansRoot?: string;
	actorAddress?: string;
}

/** Create the plan adapter with step management, gate evaluation, and context injection. */
export function createPlanAdapter(opts: PlanAdapterOptions): Adapter {
	const store = new PlanStore({
		cwd: opts.cwd,
		plansRoot: opts.plansRoot,
	});

	let cached: PlanGraph | null = null;
	let mountedBus: Bus | null = null;

	/**
	 *
	 */
	function emit(type: string, payload: Record<string, unknown>): void {
		mountedBus?.notification.publish({ type, payload, correlationId: "" });
	}

	/**
	 *
	 */
	function postToDiscourse(planId: string, thread: string, content: Record<string, unknown>): void {
		const discussionForum = process.env.ALEF_DISCUSSION_FORUM?.trim();
		const topic = discussionForum === undefined || discussionForum === "" ? "plan" : discussionForum;
		mountedBus?.command.publish({
			type: "discourse.post",
			correlationId: "",
			payload: { topic, thread, content, author: opts.actorAddress ?? "plan-adapter" },
		});
	}

	/**
	 *
	 */
	function focused(): PlanGraph | null {
		const next = store.focused();
		if (!next) {
			cached = null;
			return null;
		}
		if (cached?.id === next.id) return cached;
		cached = next;
		return cached;
	}

	/**
	 *
	 */
	function clearCache(): void {
		cached = null;
	}

	// eslint-disable-next-line @typescript-eslint/require-await
	const contextStage: ContextAssemblyHandler = async (input) => {
		const plan = focused();
		if (!plan || plan.phase === "closed") return {};
		return { messages: injectContextBlock(input.messages, plan.renderSummary(), { source: "plan" }) };
	};

	 
	/**
	 *
	 */
	// eslint-disable-next-line @typescript-eslint/require-await
	async function handleOpen(ctx: CommandHandlerCtx<z.infer<typeof PLAN_OPEN.inputSchema>>): Promise<Record<string, unknown>> {
		const plan = store.create(ctx.payload.current, ctx.payload.desired, ctx.payload.verify);
		cached = plan;
		emit("plan.opened", { planId: plan.id, desired: ctx.payload.desired, current: ctx.payload.current });
		emit("plan.dss", {
			intent: ctx.payload.desired,
			dimensions: [{ domain: "plan", key: "verify", target: ctx.payload.verify, priority: 1 }],
		});
		emit("plan.tree", { tree: plan.renderTree() });
		postToDiscourse(plan.id, plan.id, {
			type: "plan:opened",
			current: ctx.payload.current,
			desired: ctx.payload.desired,
			verify: ctx.payload.verify,
		});
		return withDisplay(
			{ id: plan.id, phase: "open" },
			{
				text: `Plan ${plan.id} opened.\nCurrent: ${ctx.payload.current}\nDesired: ${ctx.payload.desired}\nVerify: ${ctx.payload.verify}`,
				mimeType: "text/plain",
			},
		);
	}

	 
	/**
	 *
	 */
	// eslint-disable-next-line @typescript-eslint/require-await
	async function handleList(ctx: CommandHandlerCtx<z.infer<typeof PLAN_LIST.inputSchema>>): Promise<Record<string, unknown>> {
		const plans = store.list(ctx.payload.status ? { status: ctx.payload.status } : undefined);
		const lines = plans.length === 0
			? ["(no plans)"]
			: plans.map((p) => `${p.status === "active" ? "●" : p.status === "backlog" ? "○" : "✓"} ${p.id}  [${p.phase}]  ${p.desired}`);
		return withDisplay({ plans }, { text: lines.join("\n"), mimeType: "text/plain" });
	}

	 
	/**
	 *
	 */
	// eslint-disable-next-line @typescript-eslint/require-await
	async function handleFocus(ctx: CommandHandlerCtx<z.infer<typeof PLAN_FOCUS.inputSchema>>): Promise<Record<string, unknown>> {
		try {
			const plan = store.focus(ctx.payload.id);
			cached = plan;
			emit("plan.tree", { tree: plan.renderTree() });
			emit("plan.intent", { text: plan.nextReady()?.label ?? plan.desired });
			return withDisplay(
				{ id: plan.id, phase: plan.phase, desired: plan.desired },
				{ text: `Focused ${plan.id}\n${plan.renderSummary()}`, mimeType: "text/plain" },
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return withDisplay({ error: message }, { text: message, mimeType: "text/plain" });
		}
	}

	 
	/**
	 *
	 */
	// eslint-disable-next-line @typescript-eslint/require-await
	async function handleBacklog(ctx: CommandHandlerCtx<z.infer<typeof PLAN_BACKLOG.inputSchema>>): Promise<Record<string, unknown>> {
		store.backlog(ctx.payload.id);
		clearCache();
		emit("plan.tree", { tree: "" });
		emit("plan.intent", { text: "" });
		return withDisplay({ backlogged: true }, { text: "Plan backlogged. No focused plan.", mimeType: "text/plain" });
	}

	/**
	 *
	 */
	// eslint-disable-next-line @typescript-eslint/require-await
	async function handleSteps(ctx: CommandHandlerCtx<z.infer<typeof PLAN_STEPS.inputSchema>>): Promise<Record<string, unknown>> {
		const plan = focused();
		if (!plan) return withDisplay({ error: "no plan" }, { text: "No active plan. Use plan.open first.", mimeType: "text/plain" });

		const created = ctx.payload.steps.map((s) =>
			plan.addStep(s.label, s.dependsOn ?? [], s.gates ?? [], s.inspector),
		);
		store.sync(plan);
		emit("plan.tree", { tree: plan.renderTree() });
		return withDisplay(
			{ added: created.length, ids: created.map((s) => s.id) },
			{ text: `Added ${created.length} step(s): ${created.map((s) => s.id).join(", ")}`, mimeType: "text/plain" },
		);
	}

	 
	/**
	 *
	 */
	// eslint-disable-next-line @typescript-eslint/require-await
	async function handleAdvance(ctx: CommandHandlerCtx<z.infer<typeof PLAN_ADVANCE.inputSchema>>): Promise<Record<string, unknown>> {
		const plan = focused();
		if (!plan) return withDisplay({ error: "no plan" }, { text: "No active plan.", mimeType: "text/plain" });

		const { stepId, action, result, token } = ctx.payload;

		switch (action) {
			case "claim": {
				const owner = ctx.payload.owner ?? opts.actorAddress;
				if (!owner) {
					return withDisplay(
						{ error: "owner required" },
						{ text: "Claim requires owner or adapter actorAddress", mimeType: "text/plain" },
					);
				}
				const claim = plan.claimStep(stepId, owner, { leaseMs: ctx.payload.leaseMs, note: ctx.payload.note });
				if (!claim) {
					return withDisplay({ error: "cannot claim" }, { text: `Cannot claim ${stepId}`, mimeType: "text/plain" });
				}
				store.sync(plan);
				emit("plan.tree", { tree: plan.renderTree() });
				postToDiscourse(plan.id, plan.id, {
					type: "step:claimed",
					stepId,
					owner,
					token: claim.token,
					note: ctx.payload.note,
				});
				return withDisplay(
					{ stepId, status: claim.step.status, claim: claim.step.claim },
					{ text: `Claimed ${stepId} for ${owner}`, mimeType: "text/plain" },
				);
			}
			case "heartbeat": {
				const step = plan.heartbeatClaim(stepId, token ?? "", ctx.payload.leaseMs);
				if (!step) {
					return withDisplay(
						{ error: "cannot heartbeat" },
						{ text: `Cannot heartbeat ${stepId}`, mimeType: "text/plain" },
					);
				}
				store.sync(plan);
				return withDisplay(
					{ stepId, status: step.status, claim: step.claim },
					{ text: `Heartbeat applied to ${stepId}`, mimeType: "text/plain" },
				);
			}
			case "release": {
				const step = plan.releaseClaim(stepId, token ?? "");
				if (!step) {
					return withDisplay(
						{ error: "cannot release" },
						{ text: `Cannot release ${stepId}`, mimeType: "text/plain" },
					);
				}
				store.sync(plan);
				emit("plan.tree", { tree: plan.renderTree() });
				postToDiscourse(plan.id, plan.id, { type: "step:released", stepId });
				return withDisplay(
					{ stepId, status: step.status, claim: null },
					{ text: `Released ${stepId}`, mimeType: "text/plain" },
				);
			}
			case "start": {
				const step = plan.startClaimedStep(stepId, token);
				if (!step) return withDisplay({ error: "cannot start" }, { text: `Cannot start ${stepId}`, mimeType: "text/plain" });
				store.sync(plan);
				emit("step.started", { planId: plan.id, stepId, label: step.label, claim: step.claim ?? null });
				postToDiscourse(plan.id, plan.id, {
					type: "step:started",
					stepId,
					label: step.label,
					owner: step.claim?.owner,
				});
				emit("plan.intent", { text: step.label });
				emit("plan.tree", { tree: plan.renderTree() });
				const next = plan.nextReady();
				return withDisplay(
					{ stepId, status: "active", claim: step.claim ?? null, next: next?.id ?? null },
					{ text: `Started: ${step.label}`, mimeType: "text/plain" },
				);
			}
			case "done": {
				const outcome = plan.completeStep(stepId, result, token);
				if (!outcome) return withDisplay({ error: "cannot complete" }, { text: `Cannot complete ${stepId}`, mimeType: "text/plain" });
				store.sync(plan);
				const { step, gateResults } = outcome;
				if (step.status === "done") {
					const s = plan.stats();
					emit("step.completed", { planId: plan.id, stepId, result: step.result });
					mountedBus?.event.publish({
						type: "plan.gate-results",
						correlationId: "",
						payload: { stepId },
						isError: false,
						conditions: gateResults.map((g) => ({
							domain: "plan",
							key: g.gate.target,
							value: g.passed,
							confidence: 1,
							observedAt: Date.now(),
						})),
					});
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
				const step = plan.failStep(stepId, result ?? "failed", token);
				if (!step) return withDisplay({ error: "cannot fail" }, { text: `Cannot fail ${stepId}`, mimeType: "text/plain" });
				store.sync(plan);
				emit("step.failed", { planId: plan.id, stepId, reason: result });
				postToDiscourse(plan.id, plan.id, { type: "step:failed", stepId, reason: result ?? "failed" });
				emit("plan.tree", { tree: plan.renderTree() });
				return withDisplay({ stepId, status: "failed" }, { text: `Failed: ${step.label} — ${result ?? "no reason"}`, mimeType: "text/plain" });
			}
			case "drop": {
				const step = plan.dropStep(stepId, token);
				if (!step) return withDisplay({ error: "cannot drop" }, { text: `Cannot drop ${stepId}`, mimeType: "text/plain" });
				store.sync(plan);
				emit("plan.tree", { tree: plan.renderTree() });
				return withDisplay({ stepId, status: "dropped" }, { text: `Dropped: ${step.label}`, mimeType: "text/plain" });
			}
			default:
				return withDisplay({ error: "unknown action" }, { text: `Unknown action: ${action as string}`, mimeType: "text/plain" });
		}
	}

	 
	/**
	 *
	 */
	// eslint-disable-next-line @typescript-eslint/require-await
	async function handleAmend(ctx: CommandHandlerCtx<z.infer<typeof PLAN_AMEND.inputSchema>>): Promise<Record<string, unknown>> {
		const plan = focused();
		if (!plan) return withDisplay({ error: "no plan" }, { text: "No active plan.", mimeType: "text/plain" });
		plan.amend(ctx.payload);
		store.sync(plan);
		return withDisplay({ amended: true }, { text: "Plan amended.", mimeType: "text/plain" });
	}

	 
	/**
	 *
	 */
	// eslint-disable-next-line @typescript-eslint/require-await
	async function handleShow(): Promise<Record<string, unknown>> {
		const plan = focused();
		if (!plan) return withDisplay({ active: false }, { text: "No active plan. Use plan.open to start.", mimeType: "text/plain" });
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- PlanData is a plain object
		return withDisplay(plan.toJSON() as unknown as Record<string, unknown>, { text: plan.renderSummary(), mimeType: "text/plain" });
	}

	 
	/**
	 *
	 */
	// eslint-disable-next-line @typescript-eslint/require-await
	async function handleClose(ctx: CommandHandlerCtx<z.infer<typeof PLAN_CLOSE.inputSchema>>): Promise<Record<string, unknown>> {
		const plan = focused();
		if (!plan) return withDisplay({ error: "no plan" }, { text: "No active plan.", mimeType: "text/plain" });
		const planId = plan.id;
		store.close(planId, ctx.payload.summary);
		clearCache();
		emit("plan.closed", { planId, summary: ctx.payload.summary });
		postToDiscourse(planId, planId, { type: "plan:closed", summary: ctx.payload.summary, stats: plan.stats() });
		emit("plan.intent", { text: "" });
		emit("plan.tree", { tree: "" });
		const summary = plan.renderSummary();
		return withDisplay({ closed: true }, { text: `Plan closed.\n${summary}`, mimeType: "text/plain" });
	}

	return defineAdapter(
		"plan",
		{
			command: {
				"plan.open": typedAction(PLAN_OPEN, handleOpen),
				"plan.list": typedAction(PLAN_LIST, handleList),
				"plan.focus": typedAction(PLAN_FOCUS, handleFocus),
				"plan.backlog": typedAction(PLAN_BACKLOG, handleBacklog),
				"plan.steps": typedAction(PLAN_STEPS, handleSteps),
				"plan.advance": typedAction(PLAN_ADVANCE, handleAdvance),
				"plan.amend": typedAction(PLAN_AMEND, handleAmend),
				"plan.show": typedAction(PLAN_SHOW, handleShow),
				"plan.close": typedAction(PLAN_CLOSE, handleClose),
			},
		},
		{
			description: "Plan — workspace multi-plan shelf: focus one, backlog others, verify each step.",
			labels: ["plan", "reasoning"],
			directives: [
				"For 3+ step or ambiguous work: plan.open (current/desired/verify) then plan.steps; advance start→done; plan.close. Skip for single lookups. Use plan.list/focus to switch.",
			],
			sources: [{ name: "plan-file", kind: "file" }],
			onMount: (bus: Bus) => {
				mountedBus = bus;
				bus.notification.subscribe("llm.turn-error", (event) => {
					const plan = focused();
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
