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

import type { CorpusHandlerCtx, Organ, OrganLogger } from "@dpopsuev/alef-spine";
import { defineOrgan, getString } from "@dpopsuev/alef-spine";
import { z } from "zod";
import type { TodoItem, TodoStatus, TodosResult } from "./types.js";

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
		"Replace the current task list with the provided todos. " +
		"Use this to track progress on multi-step tasks. " +
		"Keep exactly one task in_progress at a time. " +
		"Skip for simple single-step work.",
	inputSchema: z.object({
		todos: z.array(TodoItemSchema).describe("The complete updated task list"),
	}),
};

export function createTodosOrgan(opts: TodosOrganOptions = {}): Organ {
	let currentTodos: TodoItem[] = [];

	function handleUpdate(ctx: CorpusHandlerCtx): Record<string, unknown> {
		const rawTodos = ctx.payload.todos;
		if (!Array.isArray(rawTodos)) throw new Error("todos.update: todos must be an array");

		const newTodos: TodoItem[] = (rawTodos as Array<Record<string, unknown>>).map((item) => {
			const status = getString(item, "status") as TodoStatus;
			if (!["pending", "in_progress", "completed"].includes(status)) {
				throw new Error(`todos.update: invalid status "${status}" for "${getString(item, "content")}"`);
			}
			return {
				content: getString(item, "content") ?? "",
				status,
				activeForm: getString(item, "activeForm"),
			};
		});

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

		const result: TodosResult = {
			todos: currentTodos,
			justCompleted,
			justStarted,
			inProgress: inProgressCount,
			completed: newTodos.filter((t) => t.status === "completed").length,
			total: newTodos.length,
		};
		return result as unknown as Record<string, unknown>;
	}

	return defineOrgan(
		"todos",
		{
			"motor/todos.update": {
				tool: TODOS_TOOL,
				handle: (ctx: CorpusHandlerCtx) => Promise.resolve(handleUpdate(ctx)),
			},
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
