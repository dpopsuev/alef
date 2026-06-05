/**
 * TodosOrgan — structured task list for multi-step agent work.
 *
 * Tool: todos.update(todos: TodoItem[])
 *   Replaces the in-memory todo list. Returns TodosResult with diff metadata:
 *   justCompleted[], justStarted, counts.
 *
 * Directive: keep exactly one task in_progress at a time.
 *            Skip for simple single-step tasks.
 *
 * Mirrors Crush internal/agent/tools/todos.go.
 * In-memory per organ instance (one process = one session). No persistence.
 */

import type { Organ, OrganLogger } from "@dpopsuev/alef-kernel";
import { defineOrgan, typedAction } from "@dpopsuev/alef-kernel";
import { z } from "zod";
import type { TodoItem, TodoStatus } from "./types.js";

export interface TodosOrganOptions {
	logger?: OrganLogger;
}

const TodoItemSchema = z.object({
	content: z.string().min(1).describe("What needs to be done (imperative form)"),
	status: z.enum(["pending", "in_progress", "completed"]).describe("Task status: pending, in_progress, or completed"),
	activeForm: z.string().optional().describe("Present-continuous form shown while active, e.g. 'Running tests'"),
});

const TODOS_TOOL = {
	name: "todos.update",
	description:
		"Replace the full task list for multi-step work tracking. Keep exactly one task in_progress at a time. " +
		"Skip for single-step tasks. Returns updated todo state with progress diff.",
	inputSchema: z.object({
		todos: z.array(TodoItemSchema).describe("The complete updated task list"),
	}),
};

export function createTodosOrgan(opts: TodosOrganOptions = {}): Organ {
	let currentTodos: TodoItem[] = [];

	function handleUpdate(ctx: {
		payload: { todos: Array<{ content: string; status: TodoStatus; activeForm?: string }> };
	}): Record<string, unknown> {
		// Zod validates todos[] items before dispatch — no manual checks needed.
		const newTodos: TodoItem[] = ctx.payload.todos.map((item) => ({
			content: item.content,
			status: item.status,
			activeForm: item.activeForm,
		}));

		const oldByContent = new Map(currentTodos.map((t) => [t.content, t.status]));
		const justCompleted: string[] = [];
		let justStarted: string | undefined;

		for (const todo of newTodos) {
			const oldStatus = oldByContent.get(todo.content);
			if (todo.status === "completed" && oldStatus !== "completed") {
				justCompleted.push(todo.content);
			}
			if (todo.status === "in_progress" && oldStatus !== "in_progress") {
				justStarted = todo.activeForm ?? todo.content;
			}
		}

		const inProgressCount = newTodos.filter((t) => t.status === "in_progress").length;
		if (inProgressCount > 1) {
			throw new Error(`todos.update: only one task may be in_progress at a time, got ${inProgressCount}`);
		}

		currentTodos = newTodos;
		return {
			todos: currentTodos,
			justCompleted,
			justStarted,
			inProgress: inProgressCount,
			completed: newTodos.filter((t) => t.status === "completed").length,
			total: newTodos.length,
		};
	}

	return defineOrgan(
		"todos",
		{
			"motor/todos.update": typedAction(TODOS_TOOL, async (ctx) => handleUpdate(ctx)),
		},
		{
			logger: opts.logger,
			description: "Structured task list for tracking multi-step agent work.",
			labels: ["todos", "tasks", "progress"],
			directives: [
				`**todos organ — task tracking for multi-step work**
Use todos.update to maintain a structured task list when working on multi-step goals.

Rules:
- Keep exactly one task in_progress at a time.
- Mark tasks completed as you finish them, not before.
- Skip for simple single-step tasks — overhead not worth it.
- Use activeForm for TUI display: "Running tests", "Editing auth.ts".
- Always include ALL tasks in each update (complete list replacement).

Status values: pending | in_progress | completed`,
			],
		},
	);
}
