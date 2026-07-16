import { type SelectItem, Text } from "@dpopsuev/alef-tui";
import type { TaskLedgerEntry } from "../state.js";
import { color } from "../theme.js";
import { openConfigPicker } from "./overlay-picker.js";
import type { Command, TuiHandlerContext } from "./types.js";

const TASK_PICKER_ID = "task-picker";
const TASK_INSPECTOR_ID = "task-inspector";
const ESC = "\x1b";

/**
 *
 */
function formatWhen(timestamp?: number): string {
	if (!timestamp) return "-";
	return new Date(timestamp).toISOString();
}

/**
 *
 */
function summarizeTask(task: TaskLedgerEntry): string {
	return `${task.taskId} [${task.status}] ${task.profile}`;
}

/**
 *
 */
function detailText(task: TaskLedgerEntry): string {
	const lines = [
		`Task: ${task.taskId}`,
		`Status: ${task.status}`,
		`Profile: ${task.profile}`,
		`Owner: ${task.ownerAddress ?? "-"}`,
		`Model: ${task.modelId ?? "-"}`,
		`Plan: ${task.planId ?? "-"}`,
		`Step: ${task.stepId ?? "-"}`,
		`Forum: ${task.discourseTopic && task.discourseThread ? `${task.discourseTopic}/${task.discourseThread}` : "-"}`,
		`Attempt: ${task.attempt ?? "-"}`,
		`Started: ${formatWhen(task.startedAt)}`,
		`Last Activity: ${formatWhen(task.lastActivityAt)}`,
		`Completed: ${formatWhen(task.completedAt)}`,
		"",
		"Chunk Tail:",
		...(task.chunkTail.length > 0 ? task.chunkTail : ["-"]),
	];
	if (task.reply) lines.push("", "Reply:", task.reply);
	if (task.error) lines.push("", "Error:", task.error);
	return lines.join("\n");
}

/**
 *
 */
function openTaskInspector(ctx: TuiHandlerContext, task: TaskLedgerEntry): void {
	const text = new Text(color(detailText(task), ctx.t.primaryFg), 1, 1);
	const close = () => {
		ctx.dispatch({ type: "overlay.hide", id: TASK_INSPECTOR_ID });
		ctx.tui.requestRender();
	};
	ctx.dispatch({
		type: "overlay.show",
		descriptor: {
			id: TASK_INSPECTOR_ID,
			component: text,
			handleInput: (data: string) => {
				if (data === ESC) {
					close();
					return true;
				}
				return false;
			},
		},
	});
	ctx.tui.requestRender();
}

export const tasks: Command = {
	name: "tasks",
	description: "Inspect tracked async tasks",
	run(ctx) {
		const tasks = [...(ctx.taskLedger ?? [])].toSorted((a, b) => b.lastActivityAt - a.lastActivityAt);
		if (tasks.length === 0) {
			ctx.writer.addNotice("No tracked async tasks.");
			ctx.tui.requestRender();
			return;
		}
		openConfigPicker(ctx.t, ctx.dispatch, () => ctx.tui.requestRender(), {
			id: TASK_PICKER_ID,
			source: () => tasks,
			toItem: (task): SelectItem => ({
				value: task.taskId,
				label: summarizeTask(task),
				description: [task.ownerAddress, task.planId, task.stepId].filter(Boolean).join(" "),
			}),
			onSelect: (task) => openTaskInspector(ctx, task),
		});
	},
};
