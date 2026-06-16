import type { ContextAssemblyHandler } from "@dpopsuev/alef-kernel";
import { defineOrgan, typedAction, withDisplay } from "@dpopsuev/alef-kernel";
import { z } from "zod";

export interface ScribeOrganOptions {
	cwd: string;
	goalId?: string;
}

const CLAIM_TOOL = {
	name: "scribe.claim",
	description:
		"Claim the next unblocked task from the active Scribe goal. " +
		"Returns the task ID, title, and goal so the agent knows what to work on next.",
	inputSchema: z.object({
		goalId: z.string().min(1).describe("Scribe goal ID to query for unblocked tasks"),
	}),
};

const COMPLETE_TOOL = {
	name: "scribe.complete",
	description: "Mark a Scribe task as completed after finishing the work.",
	inputSchema: z.object({
		taskId: z.string().min(1).describe("Scribe task ID to mark as completed"),
		summary: z.string().optional().describe("Brief summary of what was done"),
	}),
};

const CONTEXT_TOOL = {
	name: "scribe.context",
	description: "Show the current active task and goal from Scribe.",
	inputSchema: z.object({}),
};

export function createScribeOrgan(opts: ScribeOrganOptions) {
	let activeGoalId = opts.goalId ?? "";
	let activeTaskId = "";
	let activeTaskTitle = "";

	const contextStage: ContextAssemblyHandler = async (input) => {
		if (!activeTaskId || !activeTaskTitle) return {};

		const contextBlock = `[Active Task] ${activeTaskTitle} (${activeTaskId})`;
		const messages = [...input.messages];
		const systemIdx = messages.findIndex((m) => (m as { role?: string }).role === "system");
		if (systemIdx >= 0) {
			const sys = messages[systemIdx] as { role: string; content: string };
			messages[systemIdx] = { ...sys, content: `${sys.content}\n\n${contextBlock}` };
		}
		return { messages };
	};

	return defineOrgan(
		"scribe",
		{
			motor: {
				"scribe.claim": typedAction(CLAIM_TOOL, async (ctx) => {
					activeGoalId = ctx.payload.goalId;
					return withDisplay(
						{
							goalId: activeGoalId,
							instruction:
								"Use mcp__scribe__artifact with action=query, id=<goalId>, sort=topo, unblocked=true to get the next task. " +
								"Then call scribe.context to set the active task.",
						},
						{
							text: `Query Scribe for unblocked tasks under goal ${activeGoalId} using the Scribe MCP tool.`,
							mimeType: "text/plain",
						},
					);
				}),

				"scribe.complete": typedAction(COMPLETE_TOOL, async (ctx) => {
					const { taskId, summary } = ctx.payload;
					const completed = activeTaskId === taskId;
					if (completed) {
						activeTaskId = "";
						activeTaskTitle = "";
					}
					return withDisplay(
						{
							taskId,
							summary: summary ?? "",
							cleared: completed,
							instruction:
								"Use mcp__scribe__artifact with action=set, id=<taskId>, field=status, value=work.complete to mark it done in Scribe.",
						},
						{
							text: completed
								? `Task ${taskId} completed${summary ? `: ${summary}` : ""}. Active task cleared.`
								: `Task ${taskId} marked for completion.`,
							mimeType: "text/plain",
						},
					);
				}),

				"scribe.context": typedAction(CONTEXT_TOOL, async () => {
					return withDisplay(
						{
							goalId: activeGoalId || null,
							taskId: activeTaskId || null,
							taskTitle: activeTaskTitle || null,
						},
						{
							text: activeTaskId
								? `Active: ${activeTaskTitle} (${activeTaskId}) under goal ${activeGoalId}`
								: "No active task. Use scribe.claim to get the next unblocked task.",
							mimeType: "text/plain",
						},
					);
				}),
			},
		},
		{
			description: "Scribe blackboard — task dispatch and context injection from the Scribe work graph.",
			directives: [
				"Use scribe.claim to get the next unblocked task from a Scribe goal. " +
					"Use scribe.complete when done. The active task is injected into your context automatically.",
			],
			labels: ["scribe", "blackboard", "planning"],
			contributions: {
				"context.assemble": contextStage,
			},
		},
	);
}
