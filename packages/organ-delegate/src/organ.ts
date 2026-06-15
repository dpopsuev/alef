import type {
	AgentRunContext,
	BaseOrganOptions,
	ExecutionStrategy,
	Organ,
	OrganContributions,
	ToolDefinition,
} from "@dpopsuev/alef-kernel";
import {
	createCompositeAgentRunContribution,
	defineOrgan,
	typedStreamAction,
	withDisplay,
} from "@dpopsuev/alef-kernel";
import { z } from "zod";
import { strategyRegistry } from "./strategy-registry.js";

export interface AdHocSessionOptions {
	organs: readonly Organ[];
	onChunk?: (chunk: string) => void;
	systemPrompt?: string;
}

/** @deprecated profile is now an open string — any name registered in strategyRegistry is valid. */
export type DelegateProfile = string;

export interface DelegateOrganOptions extends BaseOrganOptions {
	strategies?: Record<string, ExecutionStrategy>;
	createAdHocSession?: (opts: AdHocSessionOptions) => {
		send(text: string, sender: string, timeoutMs: number): Promise<string>; // internal ad-hoc session, not ExecutionStrategy
		dispose(): void;
	};
	getParentDirectives?: () => Promise<string>;
	materializeOrgans?: (names: string[]) => Promise<Organ[]>;
}

const AGENT_RUN_NAME = "agent.run";
const AGENT_RUN_DESCRIPTION =
	"Delegate a task to an in-process subagent. Required: text (the task). Optional: profile ('explore'|'general'). " +
	"explore: read-only (files, grep, web), safe to run in parallel. " +
	"general: full tool access. " +
	"Defaults to 'explore' when profile is omitted.";

const AGENT_RUN_BASE_SCHEMA = {
	text: z.string().min(1).describe("The task or question for the subagent"),
	profile: z
		.string()
		.min(1)
		.optional()
		.describe(
			"Strategy profile name. Built-ins: 'explore' (read-only, safe to parallelize), 'general' (full tool access). " +
				"Custom profiles can be registered via strategyRegistry.register(). " +
				"Defaults to 'explore' when omitted.",
		),
	instructions: z
		.string()
		.optional()
		.describe("Additional system prompt for the subagent. Appended after the profile's base instructions."),
	inheritDirectives: z
		.boolean()
		.optional()
		.describe("Forward the parent agent's current directives as the subagent's system prompt base."),
	organs: z
		.array(z.string().min(1))
		.optional()
		.describe(
			"Override organ set: built-in names (fs, shell, web, nodesh, lector). Uses profile organs when omitted.",
		),
	timeoutMs: z
		.number()
		.default(600_000)
		.describe(
			"Wall-clock limit in ms for the entire subagent conversation (default: 600_000 = 10 min). " +
				"The LLM HTTP call timeout is fixed at 60s and is independent of this value.",
		),
} as const;

export interface DelegateOrgan extends Organ {
	registerStrategy(name: string, strategy: ExecutionStrategy): void;
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

export function createDelegateOrgan(opts: DelegateOrganOptions): DelegateOrgan {
	const strategies = new Map<string, ExecutionStrategy>(Object.entries(opts.strategies ?? {}));
	// Captured at mount time — used to publish agent.run.inner signals.
	let publishInnerSignal: ((type: string, payload: Record<string, unknown>, correlationId: string) => void) | null =
		null;

	const composite = createCompositeAgentRunContribution();

	function buildTool(): ToolDefinition {
		return {
			name: AGENT_RUN_NAME,
			description: AGENT_RUN_DESCRIPTION,
			inputSchema: z.object({ ...AGENT_RUN_BASE_SCHEMA, ...composite.mergedSchema() }),
		};
	}

	const organ = defineOrgan(
		"delegate",
		{
			sense: {
				"organ.loaded": {
					handle: async (ctx: { payload: Record<string, unknown> }) => {
						const name = ctx.payload.name as string;
						const contribution = (ctx.payload.contributions as OrganContributions | undefined)?.["agent.run"];
						if (contribution) composite.add(name, contribution);
					},
				},
				"organ.unloaded": {
					handle: async (ctx: { payload: Record<string, unknown> }) => {
						composite.remove(ctx.payload.name as string);
					},
				},
			},
			motor: {
				"agent.run": typedStreamAction(buildTool(), async function* (ctx) {
					const payload = ctx.payload as Record<string, unknown>;
					const text = payload.text as string;
					const profile = (payload.profile as string | undefined) ?? "explore";
					const timeoutMs = (payload.timeoutMs as number | undefined) ?? 600_000;
					const instructions = typeof payload.instructions === "string" ? payload.instructions : undefined;
					const inheritDirectives = payload.inheritDirectives === true;
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
							prependInstructions: (text) => instructionParts.unshift(text),
							addOrgans: (organs) => extraOrgans.push(...organs),
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

						const session = opts.createAdHocSession({
							organs: resolvedOrgans,
							onChunk: (c) => queue.push(c),
							systemPrompt,
						});
						const replyPromise = session.send(text, "human", timeoutMs).finally(() => {
							queue.finish();
							session.dispose();
						});

						for await (const chunkText of queue.iter()) yield { text: chunkText };
						const reply = await replyPromise;
						const elapsed = Date.now() - t0;
						ctx.log.debug({ profile, elapsedMs: elapsed, ok: Boolean(reply) }, "delegate:strategy:done");
						yield withDisplay(
							{ reply, profile, elapsedMs: elapsed },
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
								text: `agent.run: unknown profile '${profile}'. Available: ${available || "(none registered)"}`,
								mimeType: "text/plain",
							},
						);
						return;
					}

					const t0 = Date.now();
					const queue = new AsyncQueue();
					ctx.log.debug({ profile, timeoutMs }, "delegate:strategy:start");

					const replyPromise = strategy
						.send({
							text,
							sender: "human",
							timeoutMs,
							onChunk: (chunk: string) => {
								queue.push(chunk);
							},
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
					ctx.log.debug({ profile, elapsedMs: elapsed, ok: Boolean(reply) }, "delegate:strategy:done");
					yield withDisplay(
						{ reply, profile, elapsedMs: elapsed },
						{ text: reply || "(no reply)", mimeType: "text/plain" },
					);
				}),
			},
		},
		{
			logger: opts.logger,
			description: "Profile-based agent delegation: agent.run routes to in-process or remote strategies.",
			labels: ["delegation", "subagent", "agent.run"],
			directives: [
				`**agent.run — fast in-process delegation**

Call signature:
  agent.run({ text: "the task or question", profile: "explore" })

The text field is required — it is the prompt sent to the subagent.

Profiles:
  explore  — read-only (files, grep, web). ~0ms startup. Safe to call in parallel.
  general  — full tools (fs, shell, web, nodesh). ~0ms startup.
  <name>   — a child name from orchestration.spawn (process-isolated, started separately).

Optional parameters:
  instructions       — additional system prompt for the subagent
  inheritDirectives  — true to forward parent agent's directives to the subagent
  organs             — override organ set: ["fs", "shell", "web"]

When to use which profile:
  - Exploring code, reading files, searching: explore
  - Making edits, running commands, writing files: general
  - True isolation, different blueprint, organ dev loop: orchestration.spawn + agent.run(<name>)

**Critical:** When asked to explore or research the codebase, use parallel agent.run calls.
Do not read files sequentially yourself — delegate to subagents instead.`,
			],
		},
	) as DelegateOrgan;

	organ.registerStrategy = (name: string, strategy: ExecutionStrategy): void => {
		strategies.set(name, strategy);
	};

	// Wrap mount to capture the outer nerve's signal bus.
	const originalMount = organ.mount.bind(organ);
	organ.mount = (nerve) => {
		publishInnerSignal = (innerType, payload, correlationId) => {
			const { callId, ...innerPayload } = payload as { callId?: string } & Record<string, unknown>;
			nerve.signal.publish({
				type: "agent.run.inner",
				payload: { callId: callId ?? correlationId, innerType, innerPayload },
				correlationId,
			});
		};
		return originalMount(nerve);
	};

	Object.defineProperty(organ, "tools", {
		get(): readonly ToolDefinition[] {
			return [buildTool()];
		},
		enumerable: true,
		configurable: true,
	});

	return organ;
}
