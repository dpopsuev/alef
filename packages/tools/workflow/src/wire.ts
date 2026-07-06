import { exec } from "node:child_process";
import type { Adapter, CommandHandlerCtx } from "@dpopsuev/alef-kernel/adapter";
import { defineAdapter, typedAction } from "@dpopsuev/alef-kernel/adapter";
import { withDisplay } from "@dpopsuev/alef-kernel/payload";
import type { Bus } from "@dpopsuev/alef-kernel/bus";
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

const WorkflowStatusInputSchema = z.object({
	workflowId: z.string().optional().describe("Workflow ID. Omit to list all."),
});

const WorkflowStopInputSchema = z.object({
	workflowId: z.string().min(1).describe("Workflow ID to stop"),
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

/**
 *
 */
function evalCondition(when: string, payload: Record<string, unknown>): boolean {
	const match = /^(\w+)\s*==\s*['"]?(\w+)['"]?$/.exec(when.trim());
	if (!match) return true;
	const [, field, value] = match;
	return String(payload[field]) === value;
}

/**
 *
 */
function runShellCommand(command: string, cwd: string): Promise<{ ok: boolean; output: string }> {
	return new Promise((resolve) => {
		exec(command, { cwd, timeout: 60_000 }, (err, stdout, stderr) => {
			const output = (stdout + stderr).trim();
			resolve({ ok: !err, output: output.slice(0, 500) });
		});
	});
}

/**
 *
 */
function recordEvent(state: WireState, type: string, status: string, detail?: string) {
	state.events.push({ type, timestamp: Date.now(), status, detail });
}

/**
 *
 */
export interface WireAdapterOptions {
	cwd: string;
	dispatch: (text: string, profile: string, model?: string) => Promise<string>;
	judge?: (prompt: string, model?: string) => Promise<{ score: number; feedback: string }>;
}

const JUDGE_SYSTEM_PROMPT =
	"You are a code reviewer. Score the input 0-10 and provide feedback. Return JSON: { score: number, feedback: string }";
const JUDGE_DEFAULT_MODEL = "claude-haiku-4-5";
const DISPATCH_TIMEOUT_MS = 600_000;
const JUDGE_TIMEOUT_MS = 60_000;

interface DisposableSession {
	send?(text: string, timeoutMs?: number): Promise<string>;
	dispose(): void;
}

/**
 *
 */
export interface WireAdapterFactoryOptions {
	cwd: string;
	subagentFactory: (opts: {
		adapters: readonly unknown[];
		systemPrompt?: string;
		modelOverride?: string;
	}) => DisposableSession;
	exploreAdapters: readonly unknown[];
	generalAdapters: readonly unknown[];
}

/**
 *
 */
export function createWireAdapterWithFactory(opts: WireAdapterFactoryOptions): Adapter {
	const { subagentFactory, exploreAdapters, generalAdapters } = opts;

	return createWireAdapter({
		cwd: opts.cwd,
		async dispatch(text, profile, modelOverride) {
			const session = subagentFactory({
				adapters: profile === "explore" ? exploreAdapters : generalAdapters,
				systemPrompt: profile === "explore" ? "Read-only exploration agent. Report findings concisely." : undefined,
				modelOverride,
			});
			try {
				return await session.send!(text, DISPATCH_TIMEOUT_MS);
			} finally {
				session.dispose();
			}
		},
		async judge(prompt, modelOverride) {
			const session = subagentFactory({
				adapters: exploreAdapters,
				systemPrompt: JUDGE_SYSTEM_PROMPT,
				modelOverride: modelOverride ?? JUDGE_DEFAULT_MODEL,
			});
			try {
				const reply = await session.send!(prompt, JUDGE_TIMEOUT_MS);
				try {
					// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- JSON.parse returns unknown; shape validated by destructuring
					const parsed = JSON.parse(reply) as { score: number; feedback: string };
					return { score: parsed.score, feedback: parsed.feedback };
				} catch {
					return { score: 5, feedback: reply };
				}
			} finally {
				session.dispose();
			}
		},
	});
}

/**
 *
 */
export function createWireAdapter(opts: WireAdapterOptions): Adapter {
	let bus: Bus | null = null;

	/**
	 *
	 */
	function mountWiring(state: WireState, rules: WiringRule[]) {
		for (const rule of rules) {
			const unsub = bus?.event.subscribe(rule.on, (event) => {
				const payload = event.payload;

				if (rule.when && !evalCondition(rule.when, payload)) return;

				void (async () => {
					const retryKey = `${rule.on}→${rule.produces}`;

					if (rule.who === "validate" && rule.command) {
						const result = await runShellCommand(rule.command, opts.cwd);
						recordEvent(state, rule.on, result.ok ? "passed" : "failed", result.output);
						bus?.notification.publish({
							type: "workflow.step",
							payload: {
								workflowId: state.id,
								eventType: rule.on,
								step: "validate",
								status: result.ok ? "passed" : "failed",
							},
							correlationId: event.correlationId,
						});

						if (!result.ok && rule.reject) {
							const count = (state.retryCounters.get(retryKey) ?? 0) + 1;
							state.retryCounters.set(retryKey, count);
							if (count > (rule.maxRetries ?? 2)) {
								recordEvent(state, rule.reject, "escalated", `Max retries (${rule.maxRetries ?? 2}) exceeded`);
								bus?.notification.publish({
									type: "workflow.escalated",
									payload: { workflowId: state.id, rule: retryKey, retries: count },
									correlationId: event.correlationId,
								});
								return;
							}
							bus?.command.publish({
								type: rule.reject,
								payload: { ...payload, feedback: result.output, attempt: count },
								correlationId: event.correlationId,
							});
							return;
						}
						if (result.ok) {
							state.retryCounters.delete(retryKey);
							bus?.event.publish({
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
						bus?.notification.publish({
							type: "workflow.step",
							payload: {
								workflowId: state.id,
								eventType: rule.on,
								step: "judge",
								status: verdict.score >= threshold ? "passed" : "failed",
								score: verdict.score,
							},
							correlationId: event.correlationId,
						});

						if (verdict.score < threshold && rule.reject) {
							const count = (state.retryCounters.get(retryKey) ?? 0) + 1;
							state.retryCounters.set(retryKey, count);
							if (count > (rule.maxRetries ?? 2)) {
								recordEvent(state, rule.reject, "escalated");
								bus?.notification.publish({
									type: "workflow.escalated",
									payload: { workflowId: state.id, rule: retryKey, score: verdict.score },
									correlationId: event.correlationId,
								});
								return;
							}
							bus?.command.publish({
								type: rule.reject,
								payload: { ...payload, feedback: verdict.feedback, score: verdict.score, attempt: count },
								correlationId: event.correlationId,
							});
							return;
						}
						state.retryCounters.delete(retryKey);
						bus?.event.publish({
							type: rule.produces,
							correlationId: event.correlationId,
							payload: { ...payload, score: verdict.score },
							isError: false,
						});
						return;
					}

					if (rule.who === "gate") {
						recordEvent(state, rule.on, "routed", `→ ${rule.produces}`);
						bus?.event.publish({
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
						bus?.notification.publish({
							type: "workflow.step",
							payload: {
								workflowId: state.id,
								eventType: rule.produces,
								step: rule.who,
								status: "completed",
							},
							correlationId: event.correlationId,
						});
						bus?.event.publish({
							type: rule.produces,
							correlationId: event.correlationId,
							payload: { result: reply, text: reply },
							isError: false,
						});
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						recordEvent(state, rule.produces, "failed", msg);
						bus?.notification.publish({
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

	/**
	 *
	 */
	// eslint-disable-next-line @typescript-eslint/require-await
	async function handleWire(
		ctx: CommandHandlerCtx<z.infer<typeof WireInputSchema>>,
	): Promise<Record<string, unknown>> {
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
			const unsub = bus?.event.subscribe("done", () => {
				state.status = "completed";
				state.completedAt = Date.now();
				recordEvent(state, "done", "completed");
				bus?.notification.publish({
					type: "workflow.completed",
					payload: { workflowId: id, elapsedMs: Date.now() - state.startedAt },
					correlationId: ctx.correlationId,
				});
			});
			if (unsub) state.unmounts.push(unsub);
		}

		mountWiring(state, wiring);

		bus?.command.publish({
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
	}

	/**
	 *
	 */
	// eslint-disable-next-line @typescript-eslint/require-await
	async function handleStatus(
		ctx: CommandHandlerCtx<z.infer<typeof WorkflowStatusInputSchema>>,
	): Promise<Record<string, unknown>> {
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
	}

	/**
	 *
	 */
	// eslint-disable-next-line @typescript-eslint/require-await
	async function handleStop(
		ctx: CommandHandlerCtx<z.infer<typeof WorkflowStopInputSchema>>,
	): Promise<Record<string, unknown>> {
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
	}

	return defineAdapter(
		"workflow",
		{
			command: {
				"workflow.wire": typedAction(
					{
						name: "workflow.wire",
						description:
							"Define and start a subscription graph. Each rule: { on, who, produces } — " +
							"WHO listens to WHO for WHAT. Returns a workflow ID for status queries.",
						inputSchema: WireInputSchema,
						longRunning: true,
					},
					handleWire,
				),

				"workflow.status": typedAction(
					{
						name: "workflow.status",
						description: "Query workflow progress — events, gate results, retry counts.",
						inputSchema: WorkflowStatusInputSchema,
					},
					handleStatus,
				),

				"workflow.stop": typedAction(
					{
						name: "workflow.stop",
						description: "Stop a running workflow — unmount all subscriptions.",
						inputSchema: WorkflowStopInputSchema,
					},
					handleStop,
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
			onMount(b: Bus) {
				bus = b;
			},
			onUnmount() {
				for (const state of workflows.values()) {
					for (const unsub of state.unmounts) unsub();
				}
				workflows.clear();
				bus = null;
			},
		},
	);
}
