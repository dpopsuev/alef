import { exec } from "node:child_process";
import type { Nerve, Organ } from "@dpopsuev/alef-kernel";
import { defineOrgan, typedAction, withDisplay } from "@dpopsuev/alef-kernel";
import { z } from "zod";

const WiringRuleSchema = z.object({
	on: z.string().min(1).describe("Sense event to subscribe to (e.g. 'explore.result')"),
	who: z.string().min(1).describe("Agent profile ('explore', 'general') or gate type ('validate', 'judge', 'gate')"),
	produces: z.string().min(1).describe("Event published after processing (e.g. 'code.result')"),
	when: z
		.string()
		.optional()
		.describe("Payload field condition — route only when this field matches (e.g. 'verdict == approved')"),
	command: z.string().optional().describe("Shell command for validate gates (e.g. 'npx tsc --noEmit')"),
	prompt: z.string().optional().describe("Prompt template for judge gates — {input} is replaced with the payload"),
	model: z.string().optional().describe("Model override for agent or judge steps"),
	threshold: z.number().optional().describe("Minimum score for judge gate to pass (default: 7)"),
	maxRetries: z.number().optional().describe("Max rejection loops before escalating (default: 2)"),
	reject: z.string().optional().describe("Event to publish on gate failure (routes back for retry)"),
});

const WireInputSchema = z.object({
	name: z.string().min(1).describe("Workflow name"),
	wiring: z.array(WiringRuleSchema).min(1).describe("Subscription graph — WHO listens to WHO for WHAT"),
	start: z.string().min(1).describe("Entry event type to kick off the workflow"),
	input: z.string().min(1).describe("Initial payload text for the start event"),
});

type WiringRule = z.infer<typeof WiringRuleSchema>;

interface WireState {
	id: string;
	name: string;
	status: "running" | "completed" | "failed";
	startedAt: number;
	completedAt?: number;
	events: Array<{ type: string; timestamp: number; status: string; detail?: string }>;
	retryCounters: Map<string, number>;
	unmounts: Array<() => void>;
}

let wireSeq = 0;
const workflows = new Map<string, WireState>();

function evalCondition(when: string, payload: Record<string, unknown>): boolean {
	const match = /^(\w+)\s*==\s*['"]?(\w+)['"]?$/.exec(when.trim());
	if (!match) return true;
	const [, field, value] = match;
	return String(payload[field]) === value;
}

function runShellCommand(command: string, cwd: string): Promise<{ ok: boolean; output: string }> {
	return new Promise((resolve) => {
		exec(command, { cwd, timeout: 60_000 }, (err, stdout, stderr) => {
			const output = (stdout + stderr).trim();
			resolve({ ok: !err, output: output.slice(0, 500) });
		});
	});
}

function recordEvent(state: WireState, type: string, status: string, detail?: string) {
	state.events.push({ type, timestamp: Date.now(), status, detail });
}

export interface WireOrganOptions {
	cwd: string;
	dispatch: (text: string, profile: string, model?: string) => Promise<string>;
	judge?: (prompt: string, model?: string) => Promise<{ score: number; feedback: string }>;
}

export function createWireOrgan(opts: WireOrganOptions): Organ {
	let nerve: Nerve | null = null;

	function mountWiring(state: WireState, rules: WiringRule[]) {
		for (const rule of rules) {
			const unsub = nerve?.sense.subscribe(rule.on, (event) => {
				const payload = event.payload as Record<string, unknown>;

				if (rule.when && !evalCondition(rule.when, payload)) return;

				void (async () => {
					const retryKey = `${rule.on}→${rule.produces}`;

					if (rule.who === "validate" && rule.command) {
						const result = await runShellCommand(rule.command, opts.cwd);
						recordEvent(state, rule.on, result.ok ? "passed" : "failed", result.output);

						if (!result.ok && rule.reject) {
							const count = (state.retryCounters.get(retryKey) ?? 0) + 1;
							state.retryCounters.set(retryKey, count);
							if (count > (rule.maxRetries ?? 2)) {
								recordEvent(state, rule.reject, "escalated", `Max retries (${rule.maxRetries ?? 2}) exceeded`);
								nerve?.signal.publish({
									type: "workflow.escalated",
									payload: { workflowId: state.id, rule: retryKey, retries: count },
									correlationId: event.correlationId,
								});
								return;
							}
							nerve?.motor.publish({
								type: rule.reject,
								payload: { ...payload, feedback: result.output, attempt: count },
								correlationId: event.correlationId,
							});
							return;
						}
						if (result.ok) {
							state.retryCounters.delete(retryKey);
							nerve?.sense.publish({
								type: rule.produces,
								correlationId: event.correlationId,
								payload,
								isError: false,
							});
						}
						return;
					}

					if (rule.who === "judge" && rule.prompt && opts.judge) {
						const input = typeof payload.result === "string" ? payload.result : JSON.stringify(payload);
						const prompt = rule.prompt.replace("{input}", input);
						const verdict = await opts.judge(prompt, rule.model);
						const threshold = rule.threshold ?? 7;
						recordEvent(
							state,
							rule.on,
							verdict.score >= threshold ? "passed" : "failed",
							`score=${verdict.score} threshold=${threshold}`,
						);

						if (verdict.score < threshold && rule.reject) {
							const count = (state.retryCounters.get(retryKey) ?? 0) + 1;
							state.retryCounters.set(retryKey, count);
							if (count > (rule.maxRetries ?? 2)) {
								recordEvent(state, rule.reject, "escalated");
								nerve?.signal.publish({
									type: "workflow.escalated",
									payload: { workflowId: state.id, rule: retryKey, score: verdict.score },
									correlationId: event.correlationId,
								});
								return;
							}
							nerve?.motor.publish({
								type: rule.reject,
								payload: { ...payload, feedback: verdict.feedback, score: verdict.score, attempt: count },
								correlationId: event.correlationId,
							});
							return;
						}
						state.retryCounters.delete(retryKey);
						nerve?.sense.publish({
							type: rule.produces,
							correlationId: event.correlationId,
							payload: { ...payload, score: verdict.score },
							isError: false,
						});
						return;
					}

					if (rule.who === "gate") {
						recordEvent(state, rule.on, "routed", `→ ${rule.produces}`);
						nerve?.sense.publish({
							type: rule.produces,
							correlationId: event.correlationId,
							payload,
							isError: false,
						});
						return;
					}

					// Agent profile — delegate via opts.dispatch
					const text =
						typeof payload.text === "string"
							? payload.text
							: typeof payload.result === "string"
								? payload.result
								: JSON.stringify(payload);
					recordEvent(state, rule.on, "dispatched", `→ ${rule.who}`);

					try {
						const reply = await opts.dispatch(text, rule.who, rule.model);
						state.retryCounters.delete(retryKey);
						recordEvent(state, rule.produces, "completed");
						nerve?.sense.publish({
							type: rule.produces,
							correlationId: event.correlationId,
							payload: { result: reply, text: reply },
							isError: false,
						});
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						recordEvent(state, rule.produces, "failed", msg);
						nerve?.signal.publish({
							type: "workflow.error",
							payload: { workflowId: state.id, step: rule.who, error: msg },
							correlationId: event.correlationId,
						});
					}
				})();
			});
			if (unsub) state.unmounts.push(unsub);
		}
	}

	return defineOrgan(
		"workflow",
		{
			motor: {
				"workflow.wire": typedAction(
					{
						name: "workflow.wire",
						description:
							"Define and start a subscription graph. Each rule: { on, who, produces } — " +
							"WHO listens to WHO for WHAT. Returns a workflow ID for status queries.",
						inputSchema: WireInputSchema,
						longRunning: true,
					},
					async (ctx) => {
						const { name, wiring, start, input } = ctx.payload;
						const id = `wf-${++wireSeq}`;
						const state: WireState = {
							id,
							name,
							status: "running",
							startedAt: Date.now(),
							events: [],
							retryCounters: new Map(),
							unmounts: [],
						};
						workflows.set(id, state);

						const doneRule = wiring.find((r) => r.produces === "done");
						if (doneRule) {
							const unsub = nerve?.sense.subscribe("done", () => {
								state.status = "completed";
								state.completedAt = Date.now();
								recordEvent(state, "done", "completed");
								nerve?.signal.publish({
									type: "workflow.completed",
									payload: { workflowId: id, elapsedMs: Date.now() - state.startedAt },
									correlationId: ctx.correlationId,
								});
							});
							if (unsub) state.unmounts.push(unsub);
						}

						mountWiring(state, wiring);

						nerve?.motor.publish({
							type: start,
							payload: { text: input },
							correlationId: ctx.correlationId,
						});

						recordEvent(state, start, "started", input.slice(0, 100));

						return withDisplay(
							{ workflowId: id, name, status: "running", rules: wiring.length },
							{
								text: `Workflow '${name}' started (${id}), ${wiring.length} rules wired.`,
								mimeType: "text/plain",
							},
						);
					},
				),

				"workflow.status": typedAction(
					{
						name: "workflow.status",
						description: "Query workflow progress — events, gate results, retry counts.",
						inputSchema: z.object({
							workflowId: z.string().optional().describe("Workflow ID. Omit to list all."),
						}),
					},
					async (ctx) => {
						if (ctx.payload.workflowId) {
							const state = workflows.get(ctx.payload.workflowId);
							if (!state) {
								return withDisplay(
									{ error: "not found" },
									{ text: `Workflow ${ctx.payload.workflowId} not found`, mimeType: "text/plain" },
								);
							}
							const elapsed = (state.completedAt ?? Date.now()) - state.startedAt;
							const lines = [
								`${state.id} [${state.status}] ${state.name} — ${(elapsed / 1000).toFixed(1)}s`,
								"",
								...state.events.map(
									(e) =>
										`  ${new Date(e.timestamp).toISOString().slice(11, 19)} ${e.type} [${e.status}]${e.detail ? ` ${e.detail.slice(0, 80)}` : ""}`,
								),
							];
							return withDisplay(
								{ ...state, elapsedMs: elapsed, retryCounters: Object.fromEntries(state.retryCounters) },
								{ text: lines.join("\n"), mimeType: "text/plain" },
							);
						}

						const all = [...workflows.values()].map((s) => ({
							id: s.id,
							name: s.name,
							status: s.status,
							events: s.events.length,
							elapsedMs: (s.completedAt ?? Date.now()) - s.startedAt,
						}));
						const lines =
							all.length > 0
								? all.map(
										(w) =>
											`${w.id} [${w.status}] ${w.name} — ${w.events} events, ${(w.elapsedMs / 1000).toFixed(1)}s`,
									)
								: ["No workflows"];
						return withDisplay({ workflows: all }, { text: lines.join("\n"), mimeType: "text/plain" });
					},
				),

				"workflow.stop": typedAction(
					{
						name: "workflow.stop",
						description: "Stop a running workflow — unmount all subscriptions.",
						inputSchema: z.object({
							workflowId: z.string().min(1).describe("Workflow ID to stop"),
						}),
					},
					async (ctx) => {
						const state = workflows.get(ctx.payload.workflowId);
						if (!state) {
							return withDisplay({ error: "not found" }, { text: "Not found", mimeType: "text/plain" });
						}
						for (const unsub of state.unmounts) unsub();
						state.unmounts.length = 0;
						state.status = "completed";
						state.completedAt = Date.now();
						return withDisplay(
							{ stopped: true },
							{ text: `Workflow ${state.id} stopped`, mimeType: "text/plain" },
						);
					},
				),
			},
		},
		{
			description: "Workflow wiring — define subscription graphs: WHO listens to WHO for WHAT.",
			directives: [
				"Use workflow.wire to define a subscription graph. Each rule: { on, who, produces }.",
				"'on' = sense event to subscribe to. 'who' = agent profile or gate type. 'produces' = event published after.",
				"Gate types: 'validate' (shell command), 'judge' (LLM scoring), 'gate' (condition routing).",
				"Use workflow.status to check progress. Use workflow.stop to tear down.",
			],
			onMount(n: Nerve) {
				nerve = n;
			},
			onUnmount() {
				for (const state of workflows.values()) {
					for (const unsub of state.unmounts) unsub();
				}
				workflows.clear();
				nerve = null;
			},
		},
	);
}
