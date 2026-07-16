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
import type { ContextAssemblyHandler } from "@dpopsuev/alef-kernel/context-assembly";
import { injectContextBlock } from "@dpopsuev/alef-kernel/context-assembly";
import { withDisplay } from "@dpopsuev/alef-kernel/payload";
import type { Bus } from "@dpopsuev/alef-kernel/bus";
import type { ExecutionStrategy, RunDescriptor, TaskSnapshot } from "@dpopsuev/alef-kernel/execution";
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
	CANCEL_TOOL,
	CONVERSE_TOOL,
	KILL_TOOL,
	LIST_TOOL,
	MODELS_TOOL,
	PROMOTE_TOOL,
	RACE_TOOL,
	RETRY_TOOL,
	SPAWN_TOOL,
	STATUS_TOOL,
	TASKS_TOOL,
} from "./tool-schemas.js";

export type { ChildEntry };

/**
 *
 */
export interface AgentAdapterOptions extends BaseAdapterOptions {
	cwd?: string;
	strategies?: Record<string, ExecutionStrategy>;
	/** Supervisor for service lifecycle. When set, strategy resolution falls through to supervisor before the global registry. */
	supervisor?: { strategy(name: string): ExecutionStrategy | undefined };
	/** Subagent factory for ad-hoc sessions with custom adapters/prompt/model. */
	subagentFactory?: (opts: {
		adapters: readonly Adapter[];
		onChunk?: (chunk: string) => void;
		onInnerEvent?: (callId: string, type: string, payload: Record<string, unknown>) => void;
		systemPrompt?: string;
		run?: RunDescriptor;
		tokenBudget?: number;
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

/**
 *
 */
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

	interface AsyncTaskRecord extends TaskSnapshot {
		text: string;
		priority: "normal" | "high";
		abortController: AbortController;
		originalPayload: Record<string, unknown>;
		correlationId: string;
	}
	const asyncTasks = new Map<string, AsyncTaskRecord>();
	let taskSeq = 0;

	const composite = createCompositeAgentRunContribution();

	/**
	 *
	 */
	function makeTaskId(): string {
		taskSeq += 1;
		return `task-${taskSeq}`;
	}

	/**
	 *
	 */
	function snapshotTask(task: AsyncTaskRecord): TaskSnapshot {
		return {
			descriptor: { ...task.descriptor },
			status: task.status,
			startedAt: task.startedAt,
			completedAt: task.completedAt,
			lastActivityAt: task.lastActivityAt,
			reply: task.reply,
			error: task.error,
		};
	}

	/**
	 *
	 */
	function publishTaskEvent(
		type: "task.started" | "task.progress" | "task.completed" | "task.failed" | "task.cancelled",
		task: AsyncTaskRecord,
		correlationId: string,
		extra: Record<string, unknown> = {},
	): void {
		mountedBus?.notification.publish({
			type,
			payload: { task: snapshotTask(task), ...extra },
			correlationId,
		});
	}

	/**
	 *
	 */
	function publishInnerEvent(
		run: RunDescriptor,
		correlationId: string,
		parentCallId: string,
		innerType: string,
		innerPayload: Record<string, unknown>,
	): void {
		mountedBus?.notification.publish({
			type: "agent.run.inner",
			payload: { callId: parentCallId, innerType, innerPayload, run },
			correlationId,
		});
	}

	/**
	 *
	 */
	function deriveProfile(text: string, payload: Record<string, unknown>): string {
		const explicitProfile = typeof payload.profile === "string" ? payload.profile : undefined;
		return explicitProfile ?? (needsWriteAccess(text) ? "general" : "explore");
	}

	/** Return a string array only when every item is a string. */
	function optionalStringArray(value: unknown): string[] | undefined {
		if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return undefined;
		return value;
	}

	/** Read an arbitrary object property without propagating `any`. */
	function getUnknownProperty(value: object, key: string): unknown {
		return Reflect.get(value, key);
	}

	/** Pull optional adapter lists from strategies that expose them. */
	function strategyAdapters(strategy: ExecutionStrategy | undefined): Adapter[] {
		if (!strategy) return [];
		const adapters = getUnknownProperty(strategy, "adapters");
		return Array.isArray(adapters) ? adapters.filter((adapter): adapter is Adapter => typeof adapter === "object") : [];
	}

	/**
	 *
	 */
	type RunCommandContext = Pick<CommandHandlerCtx<unknown>, "correlationId" | "toolCallId" | "log">;

	/**
	 *
	 */
	function createRunDescriptor(
		taskId: string,
		profile: string,
		payload: Record<string, unknown>,
		ctx: RunCommandContext,
		overrides: Partial<RunDescriptor> = {},
	): RunDescriptor {
		const ownerAddress = typeof payload.ownerAddress === "string" ? payload.ownerAddress : undefined;
		const logicalAgentId = typeof payload.logicalAgentId === "string" ? payload.logicalAgentId : undefined;
		const planId = typeof payload.planId === "string" ? payload.planId : undefined;
		const stepId = typeof payload.stepId === "string" ? payload.stepId : undefined;
		const discourseTopic =
			typeof payload.discourseTopic === "string" ? payload.discourseTopic : process.env.ALEF_DISCUSSION_FORUM;
		const discourseThread =
			typeof payload.discourseThread === "string"
				? payload.discourseThread
				: stepId ?? planId ?? taskId;
		const modelId = typeof payload.model === "string" ? payload.model : undefined;
		const tokenBudget = typeof payload.tokenBudget === "number" ? payload.tokenBudget : undefined;
		return {
			taskId,
			profile,
			actorAddress: ownerAddress,
			logicalAgentId,
			parentToolCallId: ctx.toolCallId,
			sourceCallId: ctx.toolCallId,
			correlationId: ctx.correlationId,
			planId,
			stepId,
			discourseTopic,
			discourseThread,
			modelId,
			tokenBudget,
			attempt: 1,
			...overrides,
		};
	}

	const taskContextStage: ContextAssemblyHandler = (input) => {
		if (asyncTasks.size === 0) return Promise.resolve({});
		const tasks = [...asyncTasks.values()]
			.toSorted((a, b) => b.lastActivityAt - a.lastActivityAt)
			.slice(0, 5);
		const lines = tasks.map((task) => {
			const refs = [
				task.descriptor.planId ? `plan=${task.descriptor.planId}` : null,
				task.descriptor.stepId ? `step=${task.descriptor.stepId}` : null,
				task.descriptor.discourseTopic && task.descriptor.discourseThread
					? `forum=${task.descriptor.discourseTopic}/${task.descriptor.discourseThread}`
					: null,
			]
				.filter(Boolean)
				.join(" ");
			const tail = task.reply?.slice(0, 80) ?? task.error ?? "running";
			return `${task.descriptor.taskId} [${task.status}] ${task.descriptor.profile}${refs ? ` ${refs}` : ""} :: ${tail}`;
		});
		return Promise.resolve({
			messages: injectContextBlock(input.messages, `[Tasks — ${asyncTasks.size} tracked]\n${lines.join("\n")}`, {
				source: "agent-tasks",
			}),
		});
	};

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
			.describe(
				"Forward parent directives to subagent. Ignored for profile=explore (always false). Prefer omit/false for cheap reads.",
			),
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
		taskId: z.string().optional().describe("Optional stable task id for orchestration bindings."),
		logicalAgentId: z.string().optional().describe("Optional stable logical agent identity for this run."),
		ownerAddress: z.string().optional().describe("Canonical @agent owner address for this run."),
		planId: z.string().optional().describe("Bind this run to a parent plan id."),
		stepId: z.string().optional().describe("Bind this run to a parent plan step id."),
		discourseTopic: z.string().optional().describe("Bind this run to a discourse topic."),
		discourseThread: z.string().optional().describe("Bind this run to a discourse thread."),
		async: z
			.boolean()
			.optional()
			.describe(
				"Fire-and-forget: return a taskId immediately without waiting. " +
					"The subagent runs in the background. Use agent.tasks to check status and retrieve results.",
			),
	} as const;

	/**
	 *
	 */
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

	/** Parse `agent.run` input into a record with the key fields narrowed. */
	function parseRunPayload(value: unknown): Record<string, unknown> & {
		text: string;
		maxMs?: number;
		taskId?: string;
		async?: boolean;
	} {
		const parsed = buildRunTool().inputSchema.parse(value);
		if (typeof parsed !== "object" || parsed === null) {
			throw new Error("agent.run: invalid payload");
		}
		const payload: Record<string, unknown> = {};
		for (const [key, entryValue] of Object.entries(parsed)) {
			payload[key] = entryValue;
		}
		const text = payload.text;
		if (typeof text !== "string") {
			throw new Error("agent.run: text is required");
		}
		return {
			...payload,
			text,
			maxMs: typeof payload.maxMs === "number" ? payload.maxMs : undefined,
			taskId: typeof payload.taskId === "string" ? payload.taskId : undefined,
			async: payload.async === true ? true : undefined,
		};
	}

	/**
	 *
	 */
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

	/**
	 *
	 */
	async function executeDelegatedRun(
		ctx: RunCommandContext,
		payload: Record<string, unknown>,
		run: RunDescriptor,
		options: {
			text: string;
			timeoutMs: number;
			signal?: AbortSignal;
			onChunk?: (chunk: string) => void;
		},
	): Promise<{ reply: string; profile: string; elapsed: number; relevance: number }> {
		const { text, timeoutMs, signal, onChunk } = options;
		if (payload.isolate === true) {
			const isolated = await runIsolated(text, payload, timeoutMs, ctx.correlationId, ctx.toolCallId);
			return isolated;
		}

		const profile = deriveProfile(text, payload);
		const instructions = typeof payload.instructions === "string" ? payload.instructions : undefined;
		const explicitInherit = typeof payload.inheritDirectives === "boolean" ? payload.inheritDirectives : undefined;
		const inheritDirectives = profile === "explore" ? false : (explicitInherit ?? true);
		const adapterNames = optionalStringArray(payload.adapters);
		const modelOverride = typeof payload.model === "string" ? payload.model : undefined;
		const tokenBudget = typeof payload.tokenBudget === "number" ? payload.tokenBudget : undefined;
		const stallMs = typeof payload.stallMs === "number" ? payload.stallMs : DEFAULT_STALL_MS;
		const publishInner = (innerType: string, innerPayload: Record<string, unknown>) =>
			publishInnerEvent(run, ctx.correlationId, run.taskId, innerType, innerPayload);

		const needsAdHoc = instructions !== undefined || inheritDirectives || adapterNames !== undefined || modelOverride !== undefined;
		if (needsAdHoc && factory) {
			const t0 = Date.now();
			const parentDirectives =
				inheritDirectives && opts.getParentDirectives ? await opts.getParentDirectives() : "";
			const instructionParts = [parentDirectives, instructions].filter(Boolean);
			const extraAdapters: Adapter[] = [];
			const context: AgentRunContext = {
				prependInstructions: (value) => instructionParts.unshift(value),
				addAdapters: (added) => extraAdapters.push(...added),
			};
			await composite.extend(payload, context);
			const systemPrompt = instructionParts.join("\n\n") || undefined;
			let resolvedAdapters: Adapter[];
			if (adapterNames && opts.materializeAdapters) {
				resolvedAdapters = await opts.materializeAdapters(adapterNames);
			} else {
				const strategy = strategies.get(profile) ?? opts.supervisor?.strategy(profile);
				resolvedAdapters = strategyAdapters(strategy);
			}
			resolvedAdapters = [...resolvedAdapters, ...extraAdapters];
			const session = factory({
				adapters: resolvedAdapters,
				onChunk,
				onInnerEvent: (_callId, innerType, innerPayload) => publishInner(innerType, innerPayload),
				systemPrompt,
				run,
				tokenBudget,
				modelOverride,
			});
			const onAbort = () => {
				session.dispose();
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			try {
				const reply = await session.send!(text, timeoutMs);
				const elapsed = Date.now() - t0;
				const relevance = checkRelevance(text, reply);
				if (!relevance.relevant) ctx.log.warn({ profile, overlap: relevance.overlap }, "agent:low-relevance");
				if (relevance.shallow) {
					ctx.log.warn({ profile, promptLen: text.length, replyLen: reply.length }, "agent:shallow-reply");
				}
				return { reply, profile, elapsed, relevance: relevance.overlap };
			} finally {
				signal?.removeEventListener("abort", onAbort);
				session.dispose();
			}
		}

		const strategy = strategies.get(profile) ?? opts.supervisor?.strategy(profile);
		if (!strategy) {
			throw new Error(`unknown profile '${profile}'`);
		}
		const t0 = Date.now();
		const reply = await strategy.send({
			text,
			sender: "human",
			run,
			timeoutMs,
			stallMs,
			signal,
			onChunk,
			onInnerEvent: (_callId, innerType, innerPayload) => publishInner(innerType, innerPayload),
		});
		const elapsed = Date.now() - t0;
		const relevance = checkRelevance(text, reply);
		if (!relevance.relevant) ctx.log.warn({ profile, overlap: relevance.overlap }, "agent:low-relevance");
		if (relevance.shallow) {
			ctx.log.warn({ profile, promptLen: text.length, replyLen: reply.length }, "agent:shallow-reply");
		}
		return { reply, profile, elapsed, relevance: relevance.overlap };
	}

	/**
	 *
	 */
	function startAsyncTask(
		ctx: RunCommandContext,
		payload: Record<string, unknown>,
		task: AsyncTaskRecord,
	): void {
		publishTaskEvent("task.started", task, ctx.correlationId);
		void executeDelegatedRun(ctx, payload, task.descriptor, {
			text: task.text,
			timeoutMs: typeof payload.maxMs === "number" ? payload.maxMs : DEFAULT_RUN_MAX_MS,
			signal: task.abortController.signal,
			onChunk: (chunk) => {
				if (task.abortController.signal.aborted) return;
				task.lastActivityAt = Date.now();
				publishTaskEvent("task.progress", task, ctx.correlationId, { chunk });
			},
		})
			.then((result) => {
				if (task.abortController.signal.aborted) return;
				task.status = "completed";
				task.reply = result.reply;
				task.completedAt = Date.now();
				task.lastActivityAt = task.completedAt;
				task.descriptor.profile = result.profile;
				publishTaskEvent("task.completed", task, ctx.correlationId, {
					reply: result.reply,
					elapsedMs: result.elapsed,
				});
			})
			.catch((err: unknown) => {
				const elapsedMs = Date.now() - task.startedAt;
				task.completedAt = Date.now();
				task.lastActivityAt = task.completedAt;
				if (task.abortController.signal.aborted) {
					task.status = "cancelled";
					task.error = task.error ?? "Task cancelled";
					publishTaskEvent("task.cancelled", task, ctx.correlationId, {
						error: task.error,
						elapsedMs,
					});
					return;
				}
				task.status = "failed";
				task.error = err instanceof Error ? err.message : String(err);
				publishTaskEvent("task.failed", task, ctx.correlationId, {
					error: task.error,
					elapsedMs,
				});
			});
	}

	// ── extracted command handlers ───────────────────────────────────────

	/**
	 *
	 */
	// eslint-disable-next-line @typescript-eslint/require-await
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
				{ ...snapshotTask(task), elapsedMs: elapsed, text: task.text },
				{
					text: `${task.descriptor.taskId} [${task.status}] ${task.descriptor.profile} — ${task.reply?.slice(0, 200) ?? task.error ?? "running..."}`,
					mimeType: "text/plain",
				},
			);
		}
		const tasks = [...asyncTasks.values()].map((t) => ({
			id: t.descriptor.taskId,
			status: t.status,
			profile: t.descriptor.profile,
			ownerAddress: t.descriptor.actorAddress,
			planId: t.descriptor.planId,
			stepId: t.descriptor.stepId,
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

	/**
	 *
	 */
	// eslint-disable-next-line @typescript-eslint/require-await
	async function handleCancel(
		ctx: CommandHandlerCtx<{ taskId: string }>,
	): Promise<Record<string, unknown>> {
		const task = asyncTasks.get(ctx.payload.taskId);
		if (!task) {
			return withDisplay(
				{ error: "not found" },
				{ text: `Task ${ctx.payload.taskId} not found`, mimeType: "text/plain" },
			);
		}
		if (task.status !== "running") {
			return withDisplay(
				{ error: "not running", status: task.status },
				{ text: `Task ${ctx.payload.taskId} is ${task.status}, cannot cancel`, mimeType: "text/plain" },
			);
		}
		task.abortController.abort();
		task.status = "cancelled";
		task.error = "Task cancelled by user";
		task.completedAt = Date.now();
		task.lastActivityAt = task.completedAt;
		publishTaskEvent("task.cancelled", task, ctx.correlationId, {
			error: task.error,
			elapsedMs: task.completedAt - task.startedAt,
		});
		return withDisplay(
			{ taskId: task.descriptor.taskId, status: "cancelled" },
			{ text: `Task ${task.descriptor.taskId} cancelled`, mimeType: "text/plain" },
		);
	}

	/**
	 *
	 */
	async function handleRetry(
		ctx: CommandHandlerCtx<{ taskId: string }>,
	): Promise<Record<string, unknown>> {
		const task = asyncTasks.get(ctx.payload.taskId);
		if (!task) {
			return withDisplay(
				{ error: "not found" },
				{ text: `Task ${ctx.payload.taskId} not found`, mimeType: "text/plain" },
			);
		}
		if (task.status === "running") {
			return withDisplay(
				{ error: "still running" },
				{ text: `Task ${ctx.payload.taskId} is still running, cannot retry`, mimeType: "text/plain" },
			);
		}

		// Create a new task with the original payload
		const newTaskId =
			typeof task.originalPayload.taskId === "string" && task.originalPayload.taskId !== task.descriptor.taskId
				? task.originalPayload.taskId
				: makeTaskId();
		const abortController = new AbortController();
		const profile = deriveProfile(task.text, task.originalPayload);
		const descriptor = {
			...task.descriptor,
			taskId: newTaskId,
			profile,
			retryOfTaskId: task.descriptor.taskId,
			attempt: (task.descriptor.attempt ?? 1) + 1,
		};
		const newTask: AsyncTaskRecord = {
			descriptor,
			text: task.text,
			status: "running",
			startedAt: Date.now(),
			lastActivityAt: Date.now(),
			priority: task.priority,
			abortController,
			originalPayload: { ...task.originalPayload, taskId: newTaskId, profile },
			correlationId: ctx.correlationId,
		};
		asyncTasks.set(newTaskId, newTask);
		await Promise.resolve();
		startAsyncTask(ctx, newTask.originalPayload, newTask);

		return withDisplay(
			{ taskId: newTaskId, retryOf: task.descriptor.taskId, profile },
			{ text: `Task ${newTaskId} started (retry of ${task.descriptor.taskId})`, mimeType: "text/plain" },
		);
	}

	/**
	 *
	 */
	async function handleModels(
		ctx: CommandHandlerCtx<{ provider?: string }>,
	): Promise<Record<string, unknown>> {
		try {
			const { getProviders, getModels } = await import("@dpopsuev/alef-ai/models");
			const providers = ctx.payload.provider ? [ctx.payload.provider] : (getProviders());
			const result: Array<{ provider: string; id: string; name: string; contextWindow: number }> = [];
			for (const p of providers) {
				 
				for (const m of getModels(p)) {
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
					// eslint-disable-next-line @typescript-eslint/require-await
					handle: async (ctx: { payload: Record<string, unknown> }): Promise<void> => {
						// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- payload shape from bus event contract
						const name = ctx.payload.name as string;
						// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- payload shape from bus event contract
						const contribution = (ctx.payload.contributions as ReasoningContributions | undefined)?.["agent.run"];
						if (contribution) composite.add(name, contribution);
					},
				},
				"adapter.unloaded": {
					// eslint-disable-next-line @typescript-eslint/require-await
					handle: async (ctx: { payload: Record<string, unknown> }): Promise<void> => {
						// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- payload shape from bus event contract
						composite.remove(ctx.payload.name as string);
					},
				},
			},
			command: {
				"agent.run": typedStreamAction(buildRunTool(), async function* (ctx) {
					const payload = parseRunPayload(ctx.payload);
					const text = payload.text;
					const maxMs = payload.maxMs ?? DEFAULT_RUN_MAX_MS;
					const timeoutMs = maxMs;
					const profile = deriveProfile(text, payload);
					const taskId = payload.taskId ?? makeTaskId();
					const run = createRunDescriptor(taskId, profile, payload, ctx);

					if (payload.async === true) {
						const abortController = new AbortController();
						const task: AsyncTaskRecord = {
							descriptor: run,
							text,
							status: "running",
							startedAt: Date.now(),
							lastActivityAt: Date.now(),
							priority: "normal",
							abortController,
							originalPayload: { ...payload, taskId, profile },
							correlationId: ctx.correlationId,
						};
						asyncTasks.set(taskId, task);
						startAsyncTask(ctx, task.originalPayload, task);

						yield withDisplay(
							{ taskId, profile, async: true, run },
							{
								text: `Task ${taskId} started (${profile}). Use agent.tasks to check status.`,
								mimeType: "text/plain",
							},
						);
						return;
					}
					const queue = new AsyncQueue();
					const replyPromise = executeDelegatedRun(ctx, payload, run, {
						text,
						timeoutMs,
						onChunk: (chunk) => queue.push(chunk),
					}).finally(() => queue.finish());
					for await (const chunkText of queue.iter()) yield { text: chunkText };
					const result = await replyPromise;
					yield withDisplay(
						{ reply: result.reply, profile: result.profile, elapsedMs: result.elapsed, relevance: result.relevance, run },
						{ text: result.reply || "(no reply)", mimeType: "text/plain" },
					);
				}),
				"agent.tasks": typedAction(TASKS_TOOL, handleTasks),
				"agent.models": typedAction(MODELS_TOOL, handleModels),
				"agent.cancel": typedAction(CANCEL_TOOL, handleCancel),
				"agent.retry": typedAction(RETRY_TOOL, handleRetry),
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
				"context.assemble": taskContextStage,
				ui: {
					signals: {
						"agent.intent": (payload, ui) => {
							ui.setIntent(typeof payload.text === "string" ? payload.text : "");
						},
					},
				},
			},
			description:
				"Unified agent delegation and child lifecycle: run, spawn, ask, race, converse, kill, list, status, promote.",
			labels: ["delegation", "orchestration", "subagent", "lifecycle"],
			directives: [
				`agent.run({ text, profile? }) — in-process delegation.
  explore: read-only (fs/web). Never set inheritDirectives.
  general: full tools for writes.
  async:true — background; poll with agent.tasks.
Prefer direct fs/grep for small reads. Spawn/ask/kill for persistent children.`,
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
				TASKS_TOOL,
				MODELS_TOOL,
				CANCEL_TOOL,
				RETRY_TOOL,
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
