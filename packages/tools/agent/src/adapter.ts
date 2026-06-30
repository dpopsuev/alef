/**
 * AgentAdapter — unified delegation and child lifecycle management.
 *
 * Tools:
 *   agent.run     — delegate a task (in-process or process-isolated one-shot)
 *   agent.spawn   — start a persistent child process
 *   agent.ask     — send a prompt to a running child
 *   agent.race    — send prompts to multiple children in parallel
 *   agent.kill    — stop a named child
 *   agent.list    — enumerate running children
 *   agent.status  — health-check a named child
 *   agent.promote — add adapter to production blueprint, trigger blue-green
 */

import type {
	Adapter,
	AgentRunContext,
	BaseAdapterOptions,
	CommandHandlerCtx,
	ReasoningContributions,
	ToolDefinition,
} from "@dpopsuev/alef-kernel/adapter";
import {
	createCompositeAgentRunContribution,
	defineAdapter,
	typedAction,
	typedStreamAction,
} from "@dpopsuev/alef-kernel/adapter";
import { withDisplay } from "@dpopsuev/alef-kernel/payload";
import type { Bus } from "@dpopsuev/alef-kernel/bus";
import type { ExecutionStrategy } from "@dpopsuev/alef-kernel/execution";
import { z } from "zod";
import { AsyncQueue } from "./async-queue.js";
import {
	type ChildLifecycleDeps,
	handleAsk,
	handleConverse,
	handleKill,
	handleList,
	handlePromote,
	handleRace,
	handleSpawn,
	handleStatus,
} from "./child-lifecycle.js";
import type { ChildEntry } from "./child-process.js";
import { DEFAULT_MAX_DEPTH, DEFAULT_READINESS_TIMEOUT_MS, DEFAULT_RUN_MAX_MS, DEFAULT_STALL_MS } from "./constants.js";
import { Supervisor } from "@dpopsuev/alef-supervisor/supervisor";

import { checkRelevance, needsWriteAccess } from "./text-analysis.js";
import {
	ASK_TOOL,
	CONVERSE_TOOL,
	KILL_TOOL,
	LIST_TOOL,
	PROMOTE_TOOL,
	RACE_TOOL,
	SPAWN_TOOL,
	STATUS_TOOL,
} from "./tool-schemas.js";

export type { ChildEntry };

export interface AgentAdapterOptions extends BaseAdapterOptions {
	cwd?: string;
	strategies?: Record<string, ExecutionStrategy>;
	/** Supervisor for service lifecycle. When set, strategy resolution falls through to supervisor before the global registry. */
	supervisor?: { strategy(name: string): ExecutionStrategy | undefined };
	/** Subagent factory for ad-hoc sessions with custom adapters/prompt/model. */
	subagentFactory?: (opts: {
		adapters: readonly Adapter[];
		onChunk?: (chunk: string) => void;
		systemPrompt?: string;
		modelOverride?: string;
	}) => {
		send?(text: string, timeoutMs?: number): Promise<string>;
		dispose(): void;
	};
	getParentDirectives?: () => Promise<string>;
	materializeAdapters?: (names: string[]) => Promise<Adapter[]>;
	replyEvent?: string;
	readinessTimeoutMs?: number;
	writableRoots?: readonly string[];
	/** Max subagent nesting depth. Default: 3. Set 0 to disable spawning. */
	maxDepth?: number;
	allowedBlueprints?: readonly string[];
	parentAdapterNames?: ReadonlySet<string>;
}

export function createAgentAdapter(
	opts: AgentAdapterOptions,
): Adapter & { registerStrategy(name: string, strategy: ExecutionStrategy): void } {
	const strategies = new Map<string, ExecutionStrategy>(Object.entries(opts.strategies ?? {}));
	const factory = opts.subagentFactory;
	let mountedBus: Bus | null = null;

	const childSupervisor = new Supervisor();

	const deps: ChildLifecycleDeps = {
		cwd: opts.cwd ?? process.cwd(),
		replyEvent: opts.replyEvent ?? "llm.response",
		readinessTimeoutMs: opts.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS,
		currentDepth: Number(process.env.ALEF_AGENT_DEPTH) || 0,
		maxDepth: opts.maxDepth ?? DEFAULT_MAX_DEPTH,
		writableRoots: opts.writableRoots,
		allowedBlueprints: opts.allowedBlueprints,
		parentAdapterNames: opts.parentAdapterNames,
		supervisor: childSupervisor,
		strategies,
	};

	interface AsyncTask {
		id: string;
		profile: string;
		text: string;
		status: "running" | "completed" | "failed";
		reply?: string;
		error?: string;
		startedAt: number;
		completedAt?: number;
	}
	const asyncTasks = new Map<string, AsyncTask>();
	let taskSeq = 0;

	const composite = createCompositeAgentRunContribution();

	// ── agent.run — unified delegation facade ──────────────────────────

	const RUN_BASE_SCHEMA = {
		text: z.string().min(1).describe("The task or question for the subagent"),
		profile: z
			.string()
			.min(1)
			.optional()
			.describe("Strategy profile: 'explore' (read-only), 'general' (full tools), or a spawned child name."),
		model: z
			.string()
			.optional()
			.describe(
				"Model ID for the subagent (e.g. 'claude-haiku-4-5', 'claude-sonnet-4-5'). " +
					"Omit to inherit the parent's model. Use agent.models to list available models.",
			),
		instructions: z.string().optional().describe("Additional system prompt for the subagent."),
		inheritDirectives: z
			.boolean()
			.default(true)
			.describe("Forward parent directives to subagent. Default: true. Set false for lightweight exploration."),
		adapters: z.array(z.string().min(1)).optional().describe("Override adapter set."),
		isolate: z.boolean().optional().describe("true = spawn a process-isolated child for this task (ephemeral)."),
		stallMs: z
			.number()
			.default(DEFAULT_STALL_MS)
			.describe(
				"Idle timeout in ms — abort if no activity for this long (default: 120_000 = 2 min). Activity = any chunk, tool call, or event from the subagent.",
			),
		maxMs: z
			.number()
			.optional()
			.describe("Hard wall-clock cap in ms (safety net). Omit for no limit — the idle reaper handles stalls."),
		tokenBudget: z
			.number()
			.optional()
			.describe(
				"Soft token cap. When exceeded, a 'wrap up' message is injected — the agent gets one more turn to finish.",
			),
		async: z
			.boolean()
			.optional()
			.describe(
				"Fire-and-forget: return a taskId immediately without waiting. " +
					"The subagent runs in the background. Use agent.tasks to check status and retrieve results.",
			),
	} as const;

	function buildRunTool(): ToolDefinition {
		return {
			name: "agent.run",
			description:
				"Delegate a task to a subagent. Defaults to in-process (fast). " +
				"Set isolate=true for process isolation. " +
				"Profile selects the strategy: 'explore' (read-only), 'general' (full tools), or a spawned child name.",
			inputSchema: z.object({ ...RUN_BASE_SCHEMA, ...composite.mergedSchema() }),
			longRunning: true,
		};
	}

	async function runIsolated(
		text: string,
		payload: Record<string, unknown>,
		timeoutMs: number,
		correlationId: string,
		toolCallId?: string,
	): Promise<{ reply: string; profile: string; elapsed: number; relevance: number }> {
		const spawnResult = await handleSpawn(deps, {
			payload: {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- payload shape validated by tool schema
				blueprintPath: payload.blueprintPath as string | undefined,
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- payload shape validated by tool schema
				adapters: payload.adapters as string[] | undefined,
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- payload shape validated by tool schema
				cwd: payload.cwd as string | undefined,
			},
			correlationId,
		});
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- spawnResult contains name from handleSpawn
		const childName = (spawnResult as { name: string }).name;
		try {
			const askResult = await handleAsk(deps, {
				payload: { name: childName, prompt: text, maxMs: timeoutMs },
				correlationId,
				toolCallId,
			});
			const reply = String((askResult as { reply?: string }).reply ?? "");
			const relevance = checkRelevance(text, reply);
			return { reply, profile: `isolated:${childName}`, elapsed: 0, relevance: relevance.overlap };
		} finally {
			await handleKill(deps, { payload: { name: childName } });
		}
	}

	// ── extracted command handlers ───────────────────────────────────────

	async function handleTasks(
		ctx: CommandHandlerCtx<{ taskId?: string }>,
	): Promise<Record<string, unknown>> {
		if (ctx.payload.taskId) {
			const task = asyncTasks.get(ctx.payload.taskId);
			if (!task)
				return withDisplay(
					{ error: "not found" },
					{ text: `Task ${ctx.payload.taskId} not found`, mimeType: "text/plain" },
				);
			const elapsed = (task.completedAt ?? Date.now()) - task.startedAt;
			return withDisplay(
				{ ...task, elapsedMs: elapsed },
				{
					text: `${task.id} [${task.status}] ${task.profile} — ${task.reply?.slice(0, 200) ?? task.error ?? "running..."}`,
					mimeType: "text/plain",
				},
			);
		}
		const tasks = [...asyncTasks.values()].map((t) => ({
			id: t.id,
			status: t.status,
			profile: t.profile,
			elapsedMs: (t.completedAt ?? Date.now()) - t.startedAt,
			preview: t.status === "completed" ? t.reply?.slice(0, 100) : (t.error ?? "running..."),
		}));
		const lines =
			tasks.length > 0
				? tasks.map(
						(t) =>
							`${t.id} [${t.status}] ${t.profile} ${(t.elapsedMs / 1000).toFixed(1)}s — ${t.preview}`,
					)
				: ["No async tasks"];
		return withDisplay({ tasks }, { text: lines.join("\n"), mimeType: "text/plain" });
	}

	async function handleModels(
		ctx: CommandHandlerCtx<{ provider?: string }>,
	): Promise<Record<string, unknown>> {
		try {
			const { getProviders, getModels } = await import("@dpopsuev/alef-ai/models");
			const providers = ctx.payload.provider ? [ctx.payload.provider] : (getProviders() as string[]);
			const result: Array<{ provider: string; id: string; name: string; contextWindow: number }> = [];
			for (const p of providers) {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- provider string narrowed from getProviders()
				for (const m of getModels(p as never)) {
					result.push({ provider: p, id: m.id, name: m.name, contextWindow: m.contextWindow });
				}
			}
			const lines = result.map(
				(m) => `${m.provider}/${m.id} (${m.name}, ${m.contextWindow / 1000}k ctx)`,
			);
			return withDisplay(
				{ models: result, count: result.length },
				{ text: lines.join("\n"), mimeType: "text/plain" },
			);
		} catch {
			return withDisplay(
				{ models: [], count: 0 },
				{ text: "Model registry not available", mimeType: "text/plain" },
			);
		}
	}

	// ── defineAdapter ────────────────────────────────────────────────────

	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- defineAdapter returns base Adapter, extended with registerStrategy below
	const adapter = defineAdapter(
		"agent",
		{
			event: {
				"adapter.loaded": {
					handle: async (ctx: { payload: Record<string, unknown> }): Promise<void> => {
						// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- payload shape from bus event contract
						const name = ctx.payload.name as string;
						// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- payload shape from bus event contract
						const contribution = (ctx.payload.contributions as ReasoningContributions | undefined)?.["agent.run"];
						if (contribution) composite.add(name, contribution);
					},
				},
				"adapter.unloaded": {
					handle: async (ctx: { payload: Record<string, unknown> }): Promise<void> => {
						// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- payload shape from bus event contract
						composite.remove(ctx.payload.name as string);
					},
				},
			},
			command: {
				"agent.run": typedStreamAction(buildRunTool(), async function* (ctx) {
					// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- ctx.payload typed by zod schema
					const payload = ctx.payload as Record<string, unknown>;
					// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- validated by zod text schema
					const text = payload.text as string;
					const isolate = payload.isolate === true;
					// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- validated by zod maxMs schema
					const maxMs = (payload.maxMs as number | undefined) ?? DEFAULT_RUN_MAX_MS;
					const timeoutMs = maxMs;

					if (payload.async === true) {
						const taskId = `task-${++taskSeq}`;
						// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- validated by zod profile schema
						const explicitProfile = payload.profile as string | undefined;
						const profile = explicitProfile ?? (needsWriteAccess(text) ? "general" : "explore");
						const task: AsyncTask = { id: taskId, profile, text, status: "running", startedAt: Date.now() };
						asyncTasks.set(taskId, task);

						const strategy = strategies.get(profile) ?? opts.supervisor?.strategy(profile);
						if (!strategy) {
							task.status = "failed";
							task.error = `unknown profile '${profile}'`;
							yield withDisplay({ taskId, error: task.error }, { text: task.error, mimeType: "text/plain" });
							return;
						}

						strategy
							.send({
								text,
								timeoutMs,
								onChunk: (chunk) => {
									mountedBus?.notification.publish({
										type: "task.progress",
										payload: { taskId, chunk },
										correlationId: ctx.correlationId,
									});
								},
							})
							.then((reply) => {
								task.status = "completed";
								task.reply = reply;
								task.completedAt = Date.now();
								mountedBus?.notification.publish({
									type: "task.completed",
									payload: { taskId, profile, reply, elapsedMs: Date.now() - task.startedAt },
									correlationId: ctx.correlationId,
								});
							})
							.catch((err: unknown) => {
								task.status = "failed";
								task.error = err instanceof Error ? err.message : String(err);
								task.completedAt = Date.now();
								mountedBus?.notification.publish({
									type: "task.failed",
									payload: { taskId, profile, error: task.error, elapsedMs: Date.now() - task.startedAt },
									correlationId: ctx.correlationId,
								});
							});

						yield withDisplay(
							{ taskId, profile, async: true },
							{
								text: `Task ${taskId} started (${profile}). Use agent.tasks to check status.`,
								mimeType: "text/plain",
							},
						);
						return;
					}

					if (isolate) {
						const result = await runIsolated(text, payload, timeoutMs, ctx.correlationId, ctx.toolCallId);
						yield withDisplay(
							{
								reply: result.reply,
								profile: result.profile,
								elapsedMs: result.elapsed,
								relevance: result.relevance,
							},
							{ text: result.reply || "(no reply)", mimeType: "text/plain" },
						);
						return;
					}

					// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- validated by zod profile schema
					const explicitProfile = payload.profile as string | undefined;
					const profile = explicitProfile ?? (needsWriteAccess(text) ? "general" : "explore");
					const instructions = typeof payload.instructions === "string" ? payload.instructions : undefined;
					// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- validated by zod inheritDirectives schema
					const explicitInherit = payload.inheritDirectives as boolean | undefined;
					const inheritDirectives = explicitInherit ?? profile !== "explore";
					// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- validated by zod adapters schema
					const adapterNames = Array.isArray(payload.adapters) ? (payload.adapters as string[]) : undefined;

					const needsAdHoc = instructions !== undefined || inheritDirectives || adapterNames !== undefined;

					if (needsAdHoc && factory) {
						const queue = new AsyncQueue();
						const t0 = Date.now();
						const parentDirectives =
							inheritDirectives && opts.getParentDirectives ? await opts.getParentDirectives() : "";
						const instructionParts = [parentDirectives, instructions].filter(Boolean);
						const extraAdapters: Adapter[] = [];
						const context: AgentRunContext = {
							prependInstructions: (t) => instructionParts.unshift(t),
							addAdapters: (o) => extraAdapters.push(...o),
						};
						await composite.extend(payload, context);
						const systemPrompt = instructionParts.join("\n\n") || undefined;
						let resolvedAdapters: Adapter[];
						if (adapterNames && opts.materializeAdapters) {
							resolvedAdapters = await opts.materializeAdapters(adapterNames);
						} else {
							const strategy = strategies.get(profile) ?? opts.supervisor?.strategy(profile);
							// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- strategy duck-typed for optional adapters property
							resolvedAdapters = (strategy as unknown as { adapters?: Adapter[] }).adapters ?? [];
						}
						resolvedAdapters = [...resolvedAdapters, ...extraAdapters];
						const modelOverride = typeof payload.model === "string" ? payload.model : undefined;
						const session = factory({
							adapters: resolvedAdapters,
							onChunk: (c) => queue.push(c),
							systemPrompt,
							modelOverride,
						});
						const replyPromise = session.send!(text, timeoutMs).finally(() => {
							queue.finish();
							session.dispose();
						});
						for await (const chunkText of queue.iter()) yield { text: chunkText };
						const reply = await replyPromise;
						const elapsed = Date.now() - t0;
						const relevance = checkRelevance(text, reply);
						if (!relevance.relevant) ctx.log.warn({ profile, overlap: relevance.overlap }, "agent:low-relevance");
						if (relevance.shallow)
							ctx.log.warn({ profile, promptLen: text.length, replyLen: reply.length }, "agent:shallow-reply");
						yield withDisplay(
							{ reply, profile, elapsedMs: elapsed, relevance: relevance.overlap },
							{ text: reply || "(no reply)", mimeType: "text/plain" },
						);
						return;
					}

					const strategy = strategies.get(profile) ?? opts.supervisor?.strategy(profile);
					if (!strategy) {
						const available = [...strategies.keys()].join(", ");
						yield withDisplay(
							{ error: `unknown profile '${profile}'`, available },
							{
								text: `agent.run: unknown profile '${profile}'. Available: ${available || "(none)"}`,
								mimeType: "text/plain",
							},
						);
						return;
					}

					const t0 = Date.now();
					const queue = new AsyncQueue();
					const replyPromise = strategy
						.send({
							text,
							sender: "human",
							timeoutMs,
							onChunk: (chunk: string) => queue.push(chunk),
							onInnerEvent: deps.publishInnerSignal
								? (_callId, innerType, innerPayload) =>
										deps.publishInnerSignal?.(
											innerType,
											{ ...innerPayload, callId: ctx.toolCallId ?? ctx.correlationId },
											ctx.correlationId,
										)
								: undefined,
						})
						.finally(() => queue.finish());
					for await (const chunkText of queue.iter()) yield { text: chunkText };
					const reply = await replyPromise;
					const elapsed = Date.now() - t0;
					const relevance = checkRelevance(text, reply);
					if (!relevance.relevant) ctx.log.warn({ profile, overlap: relevance.overlap }, "agent:low-relevance");
					if (relevance.shallow)
						ctx.log.warn({ profile, promptLen: text.length, replyLen: reply.length }, "agent:shallow-reply");
					yield withDisplay(
						{ reply, profile, elapsedMs: elapsed, relevance: relevance.overlap },
						{ text: reply || "(no reply)", mimeType: "text/plain" },
					);
				}),
				"agent.tasks": typedAction(
					{
						name: "agent.tasks",
						description:
							"List async tasks started via agent.run(async=true). Shows status, elapsed time, and results for completed tasks.",
						inputSchema: z.object({
							taskId: z.string().optional().describe("Get details for a specific task. Omit to list all."),
						}),
					},
					handleTasks,
				),
				"agent.models": typedAction(
					{
						name: "agent.models",
						description:
							"List available LLM models. Returns model IDs that can be passed to agent.run(model=...) for subagent model selection.",
						inputSchema: z.object({
							provider: z
								.string()
								.optional()
								.describe("Filter by provider (e.g. 'anthropic', 'google-vertex'). Omit to list all."),
						}),
					},
					handleModels,
				),
				"agent.spawn": typedAction(SPAWN_TOOL, (ctx) => handleSpawn(deps, ctx)),
				"agent.ask": typedAction(ASK_TOOL, (ctx) => handleAsk(deps, ctx)),
				"agent.race": typedAction(RACE_TOOL, (ctx) => handleRace(deps, ctx)),
				"agent.converse": typedAction(CONVERSE_TOOL, (ctx) => handleConverse(deps, ctx)),
				"agent.kill": typedAction(KILL_TOOL, (ctx) => handleKill(deps, ctx)),
				"agent.list": typedAction(LIST_TOOL, () => handleList(deps)),
				"agent.status": typedAction(STATUS_TOOL, (ctx) => handleStatus(deps, ctx)),
				"agent.promote": typedAction(PROMOTE_TOOL, (ctx) => handlePromote(deps, ctx)),
			},
		},
		{
			logger: opts.logger,
			onMount: (bus) => {
				mountedBus = bus;
				deps.publishInnerSignal = (innerType, payload, correlationId) => {
					const { callId, ...innerPayload } = payload as { callId?: string } & Record<string, unknown>;
					bus.notification.publish({
						type: "agent.run.inner",
						payload: { callId: callId ?? correlationId, innerType, innerPayload },
						correlationId,
					});
				};
			},
			onUnmount: () => {
				mountedBus = null;
				deps.publishInnerSignal = undefined;
			},
			contributions: {
				ui: {
					signals: {
						"agent.intent": (payload, ui) => {
							ui.setIntent(String(payload.text ?? ""));
						},
					},
				},
			},
			description:
				"Unified agent delegation and child lifecycle: run, spawn, ask, race, converse, kill, list, status, promote.",
			labels: ["delegation", "orchestration", "subagent", "lifecycle"],
			directives: [
				`**agent adapter — delegation and child process management**

agent.run({ text, profile?, model? }) — fast in-process delegation (default).
  explore: read-only (files, grep, web). Safe to parallelize.
  general: full tools. Use when the task needs writes.
  model: override the LLM model for this subagent (e.g. 'claude-haiku-4-5' for cheap tasks).
  <child-name>: route to a spawned child process.
  isolate: true — ephemeral process isolation (spawn + ask + kill in one call).

agent.models({ provider? }) — list available LLM models for subagent selection.
agent.tasks({ taskId? }) — query status of async tasks.

Non-blocking delegation:
  agent.run({ text, async: true }) — fire-and-forget. Returns a taskId immediately.
  The subagent runs in the background. Use agent.tasks to check status and retrieve results.
  Signals emitted: task.progress (chunks), task.completed (reply), task.failed (error).

agent.spawn/ask/kill — persistent child process lifecycle.
  spawn({ blueprintPath: 'coding' | 'research' | 'factory' | path }) starts a child Alef process.
  Built-in blueprints: coding (default), research, factory.
  ask sends a prompt and waits for reply.
  kill stops it.

agent.race — parallel asks to multiple children.

agent.converse — multi-turn conversation with a child. Send a sequence of prompts; each is sent after the child replies to the previous one. Use for iterative refinement where a single ask is not enough.

When to use what:
- Exploring code, reading files: agent.run (explore)
- Making edits, running commands: agent.run (general)
- Process isolation for a single task: agent.run({ isolate: true })
- Long-running background agent: agent.spawn + repeated agent.ask
- Concurrent delegation: agent.race

When asked to explore or research the codebase, use parallel agent.run calls.`,
			],
		},
	) as Adapter & { registerStrategy(name: string, strategy: ExecutionStrategy): void };

	adapter.registerStrategy = (name: string, strategy: ExecutionStrategy): void => {
		strategies.set(name, strategy);
	};

	Object.defineProperty(adapter, "tools", {
		get(): readonly ToolDefinition[] {
			return [
				buildRunTool(),
				SPAWN_TOOL,
				ASK_TOOL,
				RACE_TOOL,
				CONVERSE_TOOL,
				KILL_TOOL,
				LIST_TOOL,
				STATUS_TOOL,
				PROMOTE_TOOL,
			].map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
		},
		enumerable: true,
		configurable: true,
	});

	return adapter;
}
