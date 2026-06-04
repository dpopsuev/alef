import type { BaseOrganOptions, ExecutionStrategy, Organ } from "@dpopsuev/alef-spine";
import { defineOrgan, typedStreamAction, withDisplay } from "@dpopsuev/alef-spine";
import { z } from "zod";

export interface DelegateOrganOptions extends BaseOrganOptions {
	strategies: Record<string, ExecutionStrategy>;
}

const AGENT_RUN_TOOL = {
	name: "agent.run",
	description:
		"Delegate a task to an in-process subagent and return its reply. " +
		"Profiles: 'explore' (read files, search code, web — ~0ms startup, safe to run in parallel), " +
		"'general' (full tool access — ~0ms startup). " +
		"Use a child name from orchestration.spawn for process-isolated delegation. " +
		"Defaults to 'explore' when profile is omitted.",
	inputSchema: z.object({
		text: z.string().min(1).describe("The task or question for the subagent"),
		profile: z
			.string()
			.optional()
			.describe("Strategy profile: 'explore', 'general', or a child name from orchestration.spawn"),
		timeoutMs: z
			.number()
			.optional()
			.describe(
				"Max wait in ms for the subagent reply (default: 90_000). The parent tool wait is this value + 10s headroom.",
			),
	}),
};

export interface DelegateOrgan extends Organ {
	registerStrategy(name: string, strategy: ExecutionStrategy): void;
}

/**
 * AsyncQueue bridges a callback-based async source (InProcessStrategy.onChunk)
 * to an AsyncIterable so typedStreamAction can yield chunks as they arrive.
 */
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
	const strategies = new Map<string, ExecutionStrategy>(Object.entries(opts.strategies));

	const organ = defineOrgan(
		"delegate",
		{
			"motor/agent.run": typedStreamAction(AGENT_RUN_TOOL, async function* (ctx) {
				const { text, profile = "explore", timeoutMs = 90_000 } = ctx.payload;
				const strategy = strategies.get(profile);
				if (!strategy) {
					const available = [...strategies.keys()].join(", ");
					yield withDisplay(
						{ error: `unknown profile '${profile}'`, available },
						{ text: `agent.run: unknown profile '${profile}'. Available: ${available}`, mimeType: "text/plain" },
					);
					return;
				}

				const t0 = Date.now();
				const queue = new AsyncQueue();

				// Send the task; chunks flow via onChunk into the queue.
				const replyPromise = strategy
					.send(text, "human", timeoutMs, (chunk) => {
						queue.push(chunk);
					})
					.finally(() => queue.finish());

				// Yield each chunk as it arrives so the TUI pill shows live progress.
				for await (const chunkText of queue.iter()) {
					yield { text: chunkText };
				}

				const reply = await replyPromise;
				const elapsed = Date.now() - t0;
				yield withDisplay(
					{ reply, profile, elapsedMs: elapsed },
					{ text: reply || "(no reply)", mimeType: "text/plain" },
				);
			}),
		},
		{
			logger: opts.logger,
			description: "Profile-based agent delegation: agent.run routes to in-process or remote strategies.",
			labels: ["delegation", "subagent", "agent.run"],
			directives: [
				`**agent.run — fast in-process delegation**
Use agent.run instead of orchestration.spawn when you need to delegate a task quickly.

Profiles:
  explore  — read-only (files, grep, web). ~0ms startup. Safe to call in parallel.
  general  — full tools (fs, shell, web, nodesh). ~0ms startup.
  <name>   — a child name from orchestration.spawn (process-isolated, started separately).

When to use which profile:
  - Exploring code, reading files, searching: explore
  - Making edits, running commands, writing files: general
  - True isolation, different blueprint, organ dev loop: orchestration.spawn + agent.run(<name>)

agent.run streams its output — each text chunk from the inner agent appears in the TUI pill.
Multiple parallel agent.run(explore) calls are safe and fast.

**Critical:** When asked to explore or research the codebase, use parallel agent.run(explore) calls.
Do not read files sequentially yourself — delegate to subagents instead.`,
			],
		},
	) as DelegateOrgan;

	organ.registerStrategy = (name: string, strategy: ExecutionStrategy): void => {
		strategies.set(name, strategy);
	};

	return organ;
}
