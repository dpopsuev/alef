import { z } from "zod";

export const SPAWN_TOOL = {
	name: "agent.spawn",
	description: "Start a persistent child Alef process. Returns { name, endpoint, sessionId, pid }.",
	inputSchema: z.object({
		blueprintPath: z
			.string()
			.optional()
			.describe(
				"Blueprint name or path. Built-in profiles: 'coding' (default — fs, shell, web, agent, skills), " +
					"'research' (same + fleet services), 'factory' (orchestration). " +
					"Or pass a path to a custom agent.yaml.",
			),
		adapters: z
			.preprocess(
				(v) => {
					if (typeof v === "string") {
						try {
							return JSON.parse(v) as unknown;
						} catch {
							return [v];
						}
					}
					return v;
				},
				z.array(z.string().min(1)),
			)
			.optional()
			.describe("Paths to .ts adapter files."),
		cwd: z.string().optional().describe("Working directory for the child."),
		sessionId: z.string().optional().describe("Resume a previous session by ID."),
		sandbox: z.boolean().optional().describe("Wrap in bubblewrap for isolation."),
		maxDepth: z
			.number()
			.int()
			.min(0)
			.optional()
			.describe("Max nesting depth for this child's own subagents. Default: parent depth - 1."),
	}),
	longRunning: true as const,
};

export const ASK_TOOL = {
	name: "agent.ask",
	description: "Send a prompt to a running child and return its reply.",
	inputSchema: z.object({
		name: z.string().min(1).describe("Child name from agent.spawn"),
		prompt: z.string().min(1).describe("Message to send"),
		stallMs: z.number().optional().describe("Inactivity threshold in ms (default: 60_000)."),
		maxMs: z.number().optional().describe("Hard wall-clock limit in ms (default: 600_000)."),
	}),
	longRunning: true as const,
};

export const RACE_TOOL = {
	name: "agent.race",
	description: "Send prompts to multiple children in parallel, return all results.",
	inputSchema: z.object({
		tasks: z
			.array(
				z.object({
					name: z.string().min(1).describe("Child name"),
					prompt: z.string().min(1).describe("Message to send"),
				}),
			)
			.min(1)
			.describe("List of {name, prompt} pairs."),
		stallMs: z.number().optional().describe("Per-child inactivity threshold (default: 60_000)."),
		maxMs: z.number().optional().describe("Hard wall-clock limit (default: 600_000)."),
	}),
	longRunning: true as const,
};

export const CONVERSE_TOOL = {
	name: "agent.converse",
	description:
		"Multi-turn conversation with a running child. Send prompts, receive replies, and decide whether to follow up or accept. " +
		"Returns the full conversation transcript. Use this when a single ask is insufficient and you need to iterate.",
	inputSchema: z.object({
		name: z.string().min(1).describe("Child name from agent.spawn"),
		prompts: z
			.array(z.string().min(1))
			.min(1)
			.describe(
				"Ordered list of prompts. The first is sent immediately. " +
					"Subsequent prompts are sent only after the child replies to the previous one.",
			),
		stallMs: z.number().optional().describe("Inactivity threshold per turn (default: 60_000)."),
		maxMs: z.number().optional().describe("Hard wall-clock limit for entire conversation (default: 600_000)."),
	}),
	longRunning: true as const,
};

export const KILL_TOOL = {
	name: "agent.kill",
	description: "Stop a named child process (SIGTERM, then SIGKILL after 3s).",
	inputSchema: z.object({ name: z.string().min(1).describe("Child name from agent.spawn") }),
};

export const LIST_TOOL = {
	name: "agent.list",
	description: "List all running child processes.",
	inputSchema: z.object({}),
};

export const STATUS_TOOL = {
	name: "agent.status",
	description: "Health-check a named child process.",
	inputSchema: z.object({ name: z.string().min(1).describe("Child name") }),
};

export const PROMOTE_TOOL = {
	name: "agent.promote",
	description: "Add adapter to production blueprint and trigger blue-green swap via supervisor IPC.",
	inputSchema: z.object({
		adapterPath: z.string().min(1).describe("Absolute path to .ts adapter file."),
		blueprintPath: z.string().optional().describe("Production blueprint path."),
	}),
};
