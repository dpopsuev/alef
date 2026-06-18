/**
 * AgentOrgan — unified delegation and child lifecycle management.
 *
 * Tools:
 *   agent.run     — delegate a task (in-process or process-isolated one-shot)
 *   agent.spawn   — start a persistent child process
 *   agent.ask     — send a prompt to a running child
 *   agent.race    — send prompts to multiple children in parallel
 *   agent.kill    — stop a named child
 *   agent.list    — enumerate running children
 *   agent.status  — health-check a named child
 *   agent.promote — add organ to production blueprint, trigger blue-green
 */

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	AgentRunContext,
	BaseOrganOptions,
	ExecutionStrategy,
	Nerve,
	Organ,
	OrganContributions,
	ToolDefinition,
} from "@dpopsuev/alef-kernel";
import {
	createCompositeAgentRunContribution,
	defineOrgan,
	typedAction,
	typedStreamAction,
	withDisplay,
} from "@dpopsuev/alef-kernel";
import { RemoteStrategy } from "@dpopsuev/alef-runtime";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { type ChildEntry, healthCheck, resolvePath, spawnChild } from "./child-process.js";
import {
	DEFAULT_ASK_MAX_MS,
	DEFAULT_ASK_STALL_MS,
	DEFAULT_MAX_DEPTH,
	DEFAULT_READINESS_TIMEOUT_MS,
	DEFAULT_RUN_MAX_MS,
	DEFAULT_STALL_MS,
	MIN_REMAINING_MS,
	SIGKILL_GRACE_MS,
} from "./constants.js";
import { strategyRegistry } from "./strategy-registry.js";
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

const WRITE_PATTERN =
	/\b(write|create|edit|modify|delete|remove|install|run|execute|build|deploy|fix|refactor|update|change|add|implement|spawn|generate)\b/i;

function extractKeywords(text: string): Set<string> {
	return new Set(
		text
			.toLowerCase()
			.replace(/[^a-z0-9\s]/g, " ")
			.split(/\s+/)
			.filter((w) => w.length > 3),
	);
}

function checkRelevance(prompt: string, reply: string): { relevant: boolean; overlap: number; shallow: boolean } {
	if (!reply || reply.length < 20) return { relevant: false, overlap: 0, shallow: true };
	const promptWords = extractKeywords(prompt);
	const replyWords = extractKeywords(reply.slice(0, 2000));
	if (promptWords.size === 0) return { relevant: true, overlap: 1, shallow: false };
	let hits = 0;
	for (const w of promptWords) if (replyWords.has(w)) hits++;
	const overlap = hits / promptWords.size;
	const shallow = prompt.length > 200 && reply.length < 100;
	return { relevant: overlap > 0.1, overlap, shallow };
}

function needsWriteAccess(text: string): boolean {
	return WRITE_PATTERN.test(text);
}

export interface AgentOrganOptions extends BaseOrganOptions {
	cwd?: string;
	strategies?: Record<string, ExecutionStrategy>;
	createAdHocSession?: (opts: {
		organs: readonly Organ[];
		onChunk?: (chunk: string) => void;
		systemPrompt?: string;
		modelOverride?: string;
	}) => {
		send(text: string, sender: string, timeoutMs: number): Promise<string>;
		dispose(): void;
	};
	getParentDirectives?: () => Promise<string>;
	materializeOrgans?: (names: string[]) => Promise<Organ[]>;
	replyEvent?: string;
	readinessTimeoutMs?: number;
	writableRoots?: readonly string[];
	/** Max subagent nesting depth. Default: 3. Set 0 to disable spawning. */
	maxDepth?: number;
}

class AsyncQueue {
	private readonly queue: string[] = [];
	private resolve: (() => void) | undefined;
	private done = false;

	push(text: string): void {
		this.queue.push(text);
		this.resolve?.();
		this.resolve = undefined;
	}

	finish(): void {
		this.done = true;
		this.resolve?.();
		this.resolve = undefined;
	}

	async *iter(): AsyncIterable<string> {
		while (true) {
			while (this.queue.length > 0) {
				const item = this.queue.shift();
				if (item !== undefined) yield item;
			}
			if (this.done) return;
			await new Promise<void>((r) => {
				this.resolve = r;
			});
		}
	}
}

export function createAgentOrgan(
	opts: AgentOrganOptions,
): Organ & { registerStrategy(name: string, strategy: ExecutionStrategy): void } {
	const cwd = opts.cwd ?? process.cwd();
	const replyEvent = opts.replyEvent ?? "llm.response";
	const readinessTimeoutMs = opts.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
	const currentDepth = Number(process.env.ALEF_AGENT_DEPTH) || 0;
	const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
	const strategies = new Map<string, ExecutionStrategy>(Object.entries(opts.strategies ?? {}));
	const children = new Map<string, ChildEntry>();
	let childSeq = 0;
	let mountedNerve: Nerve | null = null;
	let publishInnerSignal: ((type: string, payload: Record<string, unknown>, correlationId: string) => void) | null =
		null;

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
		organs: z.array(z.string().min(1)).optional().describe("Override organ set."),
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

	async function handleRunIsolated(
		text: string,
		payload: Record<string, unknown>,
		timeoutMs: number,
		correlationId: string,
		toolCallId?: string,
	): Promise<{ reply: string; profile: string; elapsed: number; relevance: number }> {
		const spawnResult = await handleSpawn({
			payload: {
				blueprintPath: payload.blueprintPath as string | undefined,
				organs: payload.organs as string[] | undefined,
				cwd: payload.cwd as string | undefined,
			},
			correlationId,
		});
		const childName = (spawnResult as { name: string }).name;
		try {
			const askResult = await handleAsk({
				payload: { name: childName, prompt: text, maxMs: timeoutMs },
				correlationId,
				toolCallId,
			});
			const reply = String((askResult as { reply?: string }).reply ?? "");
			const relevance = checkRelevance(text, reply);
			return { reply, profile: `isolated:${childName}`, elapsed: 0, relevance: relevance.overlap };
		} finally {
			await handleKill({ payload: { name: childName } });
		}
	}

	// ── agent.spawn — start a persistent child ─────────────────────────

	async function handleSpawn(ctx: {
		payload: {
			blueprintPath?: string;
			organs?: string[];
			cwd?: string;
			sessionId?: string;
			sandbox?: boolean;
			maxDepth?: number;
		};
		correlationId?: string;
	}): Promise<Record<string, unknown>> {
		if (currentDepth >= maxDepth) {
			throw new Error(
				`agent.spawn: depth limit reached (current: ${currentDepth}, max: ${maxDepth}). ` +
					`Use agent.run for in-process delegation instead.`,
			);
		}

		const result = await spawnChild({
			cwd,
			blueprintPath: ctx.payload.blueprintPath,
			organs: ctx.payload.organs,
			childCwd: ctx.payload.cwd,
			sessionId: ctx.payload.sessionId,
			sandbox: ctx.payload.sandbox,
			readinessTimeoutMs,
			writableRoots: opts.writableRoots,
			childDepth: currentDepth + 1,
		});

		const name = `child-${++childSeq}`;
		const entry: ChildEntry = {
			name,
			endpoint: result.endpoint,
			sessionId: result.sessionId,
			pid: result.child.pid ?? 0,
			process: result.child,
			startedAt: Date.now(),
			tmpDir: result.tmpDir,
		};
		children.set(name, entry);

		const strategy = new RemoteStrategy({ endpoint: result.endpoint, replyEvent });
		strategies.set(name, strategy);

		result.child.once("exit", (code) => {
			children.delete(name);
			strategies.delete(name);
			if (result.tmpDir) rmSync(result.tmpDir, { recursive: true, force: true });
			mountedNerve?.sense.publish({
				type: "child.reaped",
				correlationId: "system",
				isError: false,
				payload: { name, reason: "exited", exitCode: code ?? undefined },
			});
		});

		return withDisplay(
			{ name, endpoint: result.endpoint, sessionId: result.sessionId ?? "", pid: entry.pid },
			{ text: `Spawned **${name}** (pid ${entry.pid}) at ${result.endpoint}`, mimeType: "text/markdown" },
		);
	}

	// ── agent.ask — send prompt to running child ───────────────────────

	async function handleAsk(ctx: {
		payload: { name: string; prompt: string; stallMs?: number; maxMs?: number };
		toolCallId?: string;
		correlationId: string;
	}): Promise<Record<string, unknown>> {
		const { name: childName, prompt, stallMs = DEFAULT_ASK_STALL_MS, maxMs = DEFAULT_ASK_MAX_MS } = ctx.payload;
		const parentCallId = ctx.toolCallId ?? ctx.correlationId;
		const entry = children.get(childName);
		if (!entry) throw new Error(`agent.ask: no child named '${childName}'`);

		const strategy = new RemoteStrategy({
			endpoint: entry.endpoint,
			replyEvent,
			stallMs,
			onStall: () => {
				entry.process.kill("SIGTERM");
				children.delete(childName);
				strategies.delete(childName);
				mountedNerve?.sense.publish({
					type: "child.reaped",
					correlationId: "system",
					isError: false,
					payload: { name: childName, reason: "stall" },
				});
			},
		});
		const reply = await strategy.send({
			text: prompt,
			sender: "human",
			timeoutMs: maxMs,
			onInnerEvent: publishInnerSignal
				? (_callId, innerType, innerPayload) =>
						publishInnerSignal?.(innerType, { ...innerPayload, callId: parentCallId }, ctx.correlationId)
				: undefined,
		});
		if (!reply) {
			return withDisplay(
				{ name: childName, reply: null, timedOut: true },
				{ text: `**${childName}** did not reply`, mimeType: "text/markdown" },
			);
		}
		return withDisplay({ name: childName, reply }, { text: reply, mimeType: "text/plain" });
	}

	// ── agent.race — parallel ask to multiple children ──────────────────

	async function handleRace(ctx: {
		payload: { tasks: Array<{ name: string; prompt: string }>; stallMs?: number; maxMs?: number };
		toolCallId?: string;
		correlationId: string;
	}): Promise<Record<string, unknown>> {
		const { tasks, stallMs = DEFAULT_ASK_STALL_MS, maxMs = DEFAULT_ASK_MAX_MS } = ctx.payload;
		const parentCallId = ctx.toolCallId ?? ctx.correlationId;
		const results = await Promise.allSettled(
			tasks.map(async ({ name: childName, prompt }) => {
				const entry = children.get(childName);
				if (!entry) return { name: childName, reply: null, error: `no child named '${childName}'` };
				const strategy = new RemoteStrategy({ endpoint: entry.endpoint, replyEvent, stallMs });
				try {
					const reply = await strategy.send({
						text: prompt,
						sender: "human",
						timeoutMs: maxMs,
						onInnerEvent: publishInnerSignal
							? (_callId, innerType, innerPayload) =>
									publishInnerSignal?.(innerType, { ...innerPayload, callId: parentCallId }, ctx.correlationId)
							: undefined,
					});
					return { name: childName, reply: reply || null, error: null };
				} catch (err) {
					return { name: childName, reply: null, error: String(err) };
				}
			}),
		);
		const resolved = results.map((r, i) => {
			if (r.status === "fulfilled") return r.value;
			return { name: tasks[i]?.name ?? "unknown", reply: null, error: String(r.reason) };
		});
		const summary = resolved
			.map(
				(r) =>
					`- **${r.name}**: ${r.reply ? `replied (${String(r.reply).length} chars)` : (r.error ?? "no reply")}`,
			)
			.join("\n");
		return withDisplay(
			{ results: resolved, succeeded: resolved.filter((r) => r.reply !== null).length, total: tasks.length },
			{ text: summary, mimeType: "text/markdown" },
		);
	}

	// ── agent.converse — multi-turn hub & spoke ───────────────────────

	async function handleConverse(ctx: {
		payload: { name: string; prompts: string[]; stallMs?: number; maxMs?: number };
		toolCallId?: string;
		correlationId: string;
	}): Promise<Record<string, unknown>> {
		const { name: childName, prompts, stallMs = DEFAULT_ASK_STALL_MS, maxMs = DEFAULT_ASK_MAX_MS } = ctx.payload;
		const parentCallId = ctx.toolCallId ?? ctx.correlationId;
		const entry = children.get(childName);
		if (!entry) throw new Error(`agent.converse: no child named '${childName}'`);

		const transcript: Array<{ role: "parent" | "child"; text: string }> = [];
		const conversationStart = Date.now();

		for (const prompt of prompts) {
			if (Date.now() - conversationStart > maxMs) {
				transcript.push({ role: "parent", text: "[conversation timed out]" });
				break;
			}

			transcript.push({ role: "parent", text: prompt });

			const remainingMs = Math.max(MIN_REMAINING_MS, maxMs - (Date.now() - conversationStart));
			const strategy = new RemoteStrategy({
				endpoint: entry.endpoint,
				replyEvent,
				stallMs,
				onStall: () => {
					transcript.push({ role: "child", text: "[stalled — no activity]" });
				},
			});

			try {
				const reply = await strategy.send({
					text: prompt,
					sender: "human",
					timeoutMs: remainingMs,
					onInnerEvent: publishInnerSignal
						? (_callId, innerType, innerPayload) =>
								publishInnerSignal?.(innerType, { ...innerPayload, callId: parentCallId }, ctx.correlationId)
						: undefined,
				});
				transcript.push({ role: "child", text: reply || "(no reply)" });
			} catch (err) {
				transcript.push({ role: "child", text: `[error: ${String(err)}]` });
				break;
			}
		}

		const summary = transcript
			.map((t) => `**${t.role}:** ${t.text.slice(0, 200)}${t.text.length > 200 ? "..." : ""}`)
			.join("\n\n");

		return withDisplay(
			{ name: childName, transcript, turns: transcript.length, elapsedMs: Date.now() - conversationStart },
			{ text: summary, mimeType: "text/markdown" },
		);
	}

	// ── agent.kill — stop a child ──────────────────────────────────────

	async function handleKill(ctx: { payload: { name: string } }): Promise<Record<string, unknown>> {
		const { name: childName } = ctx.payload;
		const entry = children.get(childName);
		if (!entry) return { stopped: false, reason: `no child named '${childName}'` };
		entry.process.kill("SIGTERM");
		await new Promise<void>((res) => {
			// lint-ignore: RAWTIMER SIGKILL escalation
			const t = setTimeout(() => {
				entry.process.kill("SIGKILL");
				res();
			}, SIGKILL_GRACE_MS);
			entry.process.once("exit", () => {
				clearTimeout(t);
				res();
			});
		});
		children.delete(childName);
		strategies.delete(childName);
		return withDisplay(
			{ stopped: true, name: childName },
			{ text: `Stopped **${childName}**`, mimeType: "text/markdown" },
		);
	}

	// ── agent.list / agent.status ──────────────────────────────────────

	async function handleList(): Promise<Record<string, unknown>> {
		const items = await Promise.all(
			[...children.values()].map(async (e) => ({
				name: e.name,
				endpoint: e.endpoint,
				sessionId: e.sessionId ?? null,
				pid: e.pid,
				uptimeMs: Date.now() - e.startedAt,
				alive: await healthCheck(e.endpoint),
			})),
		);
		const summary =
			items.length === 0
				? "No running children."
				: items.map((c) => `- **${c.name}** pid=${c.pid} ${c.alive ? "alive" : "dead"} ${c.endpoint}`).join("\n");
		return withDisplay({ children: items }, { text: summary, mimeType: "text/markdown" });
	}

	async function handleStatus(ctx: { payload: { name: string } }): Promise<Record<string, unknown>> {
		const { name: childName } = ctx.payload;
		const entry = children.get(childName);
		if (!entry) return { alive: false, reason: `no child named '${childName}'` };
		const alive = await healthCheck(entry.endpoint);
		const uptimeMs = Date.now() - entry.startedAt;
		return withDisplay(
			{ name: childName, alive, endpoint: entry.endpoint, sessionId: entry.sessionId ?? null, uptimeMs },
			{
				text: `**${childName}** ${alive ? "alive" : "dead"} — uptime ${Math.round(uptimeMs / 1000)}s`,
				mimeType: "text/markdown",
			},
		);
	}

	// ── agent.promote — blue-green swap ────────────────────────────────

	function handlePromote(ctx: { payload: { organPath: string; blueprintPath?: string } }): Record<string, unknown> {
		const organPath = resolvePath(ctx.payload.organPath, cwd);
		const blueprintPath = ctx.payload.blueprintPath
			? resolvePath(ctx.payload.blueprintPath, cwd)
			: (process.env.ALEF_BLUEPRINT_PATH ?? join(homedir(), ".config", "alef", "agent.yaml"));
		let doc: Record<string, unknown> = {};
		try {
			doc = parseYaml(readFileSync(blueprintPath, "utf-8")) as Record<string, unknown>;
		} catch {
			/* start fresh */
		}
		const spec = (doc.spec ?? {}) as Record<string, unknown>;
		const organs = Array.isArray(spec.organs) ? [...spec.organs] : [];
		if (!organs.some((o) => (o as { path?: string }).path === organPath)) organs.push({ path: organPath });
		spec.organs = organs;
		doc.spec = spec;
		writeFileSync(blueprintPath, stringifyYaml(doc), "utf-8");
		const underSupervisor = process.env.ALEF_SUPERVISOR === "1" && typeof process.send === "function";
		if (underSupervisor) {
			process.send?.({ type: "rebuild" });
			return { promoted: true, organPath, blueprintPath };
		}
		return { promoted: false, reason: "not running under supervisor", organPath, blueprintPath };
	}

	// ── defineOrgan ────────────────────────────────────────────────────

	const organ = defineOrgan(
		"agent",
		{
			sense: {
				"organ.loaded": {
					handle: async (ctx: { payload: Record<string, unknown> }): Promise<void> => {
						const name = ctx.payload.name as string;
						const contribution = (ctx.payload.contributions as OrganContributions | undefined)?.["agent.run"];
						if (contribution) composite.add(name, contribution);
					},
				},
				"organ.unloaded": {
					handle: async (ctx: { payload: Record<string, unknown> }): Promise<void> => {
						composite.remove(ctx.payload.name as string);
					},
				},
			},
			motor: {
				"agent.run": typedStreamAction(buildRunTool(), async function* (ctx) {
					const payload = ctx.payload as Record<string, unknown>;
					const text = payload.text as string;
					const isolate = payload.isolate === true;
					const maxMs = (payload.maxMs as number | undefined) ?? DEFAULT_RUN_MAX_MS;
					const timeoutMs = maxMs;

					if (payload.async === true) {
						const taskId = `task-${++taskSeq}`;
						const explicitProfile = payload.profile as string | undefined;
						const profile = explicitProfile ?? (needsWriteAccess(text) ? "general" : "explore");
						const task: AsyncTask = { id: taskId, profile, text, status: "running", startedAt: Date.now() };
						asyncTasks.set(taskId, task);

						const strategy = strategies.get(profile) ?? strategyRegistry.resolve(profile);
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
									mountedNerve?.signal.publish({
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
								mountedNerve?.signal.publish({
									type: "task.completed",
									payload: { taskId, profile, reply, elapsedMs: Date.now() - task.startedAt },
									correlationId: ctx.correlationId,
								});
							})
							.catch((err: unknown) => {
								task.status = "failed";
								task.error = err instanceof Error ? err.message : String(err);
								task.completedAt = Date.now();
								mountedNerve?.signal.publish({
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
						const result = await handleRunIsolated(text, payload, timeoutMs, ctx.correlationId, ctx.toolCallId);
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

					const explicitProfile = payload.profile as string | undefined;
					const profile = explicitProfile ?? (needsWriteAccess(text) ? "general" : "explore");
					const instructions = typeof payload.instructions === "string" ? payload.instructions : undefined;
					const explicitInherit = payload.inheritDirectives as boolean | undefined;
					const inheritDirectives = explicitInherit ?? profile !== "explore";
					const organNames = Array.isArray(payload.organs) ? (payload.organs as string[]) : undefined;

					const needsAdHoc = instructions !== undefined || inheritDirectives || organNames !== undefined;

					if (needsAdHoc && opts.createAdHocSession) {
						const queue = new AsyncQueue();
						const t0 = Date.now();
						const parentDirectives =
							inheritDirectives && opts.getParentDirectives ? await opts.getParentDirectives() : "";
						const instructionParts = [parentDirectives, instructions].filter(Boolean);
						const extraOrgans: Organ[] = [];
						const context: AgentRunContext = {
							prependInstructions: (t) => instructionParts.unshift(t),
							addOrgans: (o) => extraOrgans.push(...o),
						};
						await composite.extend(payload, context);
						const systemPrompt = instructionParts.join("\n\n") || undefined;
						let resolvedOrgans: Organ[];
						if (organNames && opts.materializeOrgans) {
							resolvedOrgans = await opts.materializeOrgans(organNames);
						} else {
							const strategy = strategies.get(profile) ?? strategyRegistry.resolve(profile);
							resolvedOrgans = (strategy as unknown as { organs?: Organ[] }).organs ?? [];
						}
						resolvedOrgans = [...resolvedOrgans, ...extraOrgans];
						const modelOverride = typeof payload.model === "string" ? payload.model : undefined;
						const session = opts.createAdHocSession({
							organs: resolvedOrgans,
							onChunk: (c) => queue.push(c),
							systemPrompt,
							modelOverride,
						});
						const replyPromise = session.send(text, "human", timeoutMs).finally(() => {
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

					const strategy = strategies.get(profile) ?? strategyRegistry.resolve(profile);
					if (!strategy) {
						const available = [...new Set([...strategies.keys(), ...strategyRegistry.list()])].join(", ");
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
							onInnerEvent: publishInnerSignal
								? (_callId, innerType, innerPayload) =>
										publishInnerSignal?.(
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
					async (ctx) => {
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
					},
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
					async (ctx) => {
						try {
							const { getProviders, getModels } = await import("@dpopsuev/alef-llm");
							const providers = ctx.payload.provider ? [ctx.payload.provider] : (getProviders() as string[]);
							const result: Array<{ provider: string; id: string; name: string; contextWindow: number }> = [];
							for (const p of providers) {
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
					},
				),
				"agent.spawn": typedAction(SPAWN_TOOL, handleSpawn),
				"agent.ask": typedAction(ASK_TOOL, handleAsk),
				"agent.race": typedAction(RACE_TOOL, handleRace),
				"agent.converse": typedAction(CONVERSE_TOOL, handleConverse),
				"agent.kill": typedAction(KILL_TOOL, handleKill),
				"agent.list": typedAction(LIST_TOOL, handleList),
				"agent.status": typedAction(STATUS_TOOL, handleStatus),
				"agent.promote": typedAction(PROMOTE_TOOL, async (ctx) => Promise.resolve(handlePromote(ctx))),
			},
		},
		{
			logger: opts.logger,
			onMount: (nerve) => {
				mountedNerve = nerve;
				publishInnerSignal = (innerType, payload, correlationId) => {
					const { callId, ...innerPayload } = payload as { callId?: string } & Record<string, unknown>;
					nerve.signal.publish({
						type: "agent.run.inner",
						payload: { callId: callId ?? correlationId, innerType, innerPayload },
						correlationId,
					});
				};
			},
			onUnmount: () => {
				mountedNerve = null;
				publishInnerSignal = null;
			},
			description:
				"Unified agent delegation and child lifecycle: run, spawn, ask, race, converse, kill, list, status, promote.",
			labels: ["delegation", "orchestration", "subagent", "lifecycle"],
			directives: [
				`**agent organ — delegation and child process management**

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
  spawn starts a full child Alef process (15-30s startup).
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
	) as Organ & { registerStrategy(name: string, strategy: ExecutionStrategy): void };

	organ.registerStrategy = (name: string, strategy: ExecutionStrategy): void => {
		strategies.set(name, strategy);
	};

	Object.defineProperty(organ, "tools", {
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

	return organ;
}
