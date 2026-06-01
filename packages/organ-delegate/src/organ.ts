import type { DelegationStrategy, Organ, OrganLogger } from "@dpopsuev/alef-spine";
import { defineOrgan, typedAction, withDisplay } from "@dpopsuev/alef-spine";
import { z } from "zod";

export interface DelegateOrganOptions {
	strategies: Record<string, DelegationStrategy>;
	cwd?: string;
	logger?: OrganLogger;
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
		text: z.string().describe("The task or question for the subagent"),
		profile: z
			.string()
			.optional()
			.describe("Strategy profile: 'explore', 'general', or a child name from orchestration.spawn"),
		timeoutMs: z.number().optional().describe("Max wait in ms (default: 60_000)"),
	}),
};

export interface DelegateOrgan extends Organ {
	registerStrategy(name: string, strategy: DelegationStrategy): void;
}

export function createDelegateOrgan(opts: DelegateOrganOptions): DelegateOrgan {
	const strategies = new Map<string, DelegationStrategy>(Object.entries(opts.strategies));

	async function handleRun(ctx: {
		payload: { text: string; profile?: string; timeoutMs?: number };
	}): Promise<Record<string, unknown>> {
		const { text, profile = "explore", timeoutMs = 60_000 } = ctx.payload;
		const strategy = strategies.get(profile);
		if (!strategy) {
			const available = [...strategies.keys()].join(", ");
			throw new Error(`agent.run: unknown profile '${profile}'. Available: ${available}`);
		}
		const t0 = Date.now();
		const reply = await strategy.send(text, "human", timeoutMs);
		const elapsed = Date.now() - t0;
		return withDisplay(
			{ reply, profile, elapsedMs: elapsed },
			{ text: reply || "(no reply)", mimeType: "text/plain" },
		);
	}

	const organ = defineOrgan(
		"delegate",
		{ "motor/agent.run": typedAction(AGENT_RUN_TOOL, handleRun) },
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

agent.run is blocking — it waits for the subagent's reply before returning.
Multiple parallel agent.run(explore) calls are safe and fast.`,
			],
		},
	) as DelegateOrgan;

	organ.registerStrategy = (name: string, strategy: DelegationStrategy): void => {
		strategies.set(name, strategy);
	};

	return organ;
}
