import type { TaskSnapshot } from "@dpopsuev/alef-kernel/execution";
import { describe, expect, it } from "vitest";
import { dispatchEvent } from "../src/client/events.js";
import { initialDispatchState } from "../src/client/state.js";

function noopUi() {
	return {
		writer: {
			addCompletedToolBlock: () => {},
			addAgentReply: () => {},
			addBatchTiming: () => {},
			addNotice: () => {},
			addSubagentReply: () => {},
			addTokenFooter: () => ({ setText: () => {} }),
			addUserMessage: () => {},
			clearAll: () => {},
		},
		replyBlock: { reset: () => {}, clear: () => {}, hideThinking: false, setHideThinking: () => {} },
		replyTW: { receive: () => {}, flush: () => {}, reset: () => {} },
		thinkingTW: { receive: () => {}, flush: () => {}, reset: () => {} },
		promptConsole: {
			pulse: () => {},
			showPendingFooter: () => {},
			hidePendingFooter: () => {},
			showInFlightCall: () => {},
			removeInFlightCall: () => {},
			updateInFlightCallChunk: () => {},
			startThinking: () => {},
			stopThinking: () => {},
			setIntent: () => {},
			setTopicLabel: () => {},
			setStatus: () => {},
			setNotice: () => {},
			onTurnComplete: () => {},
			isThinking: false,
			setWidgetAbove: () => {},
			widgetSlotAbove: { addChild: () => {}, removeChild: () => {} },
			widgetSlotBelow: { addChild: () => {}, removeChild: () => {} },
			setFocusedCall: () => {},
			setChunkText: () => {},
			setCallIdentity: () => {},
			updateCallTokens: () => {},
			addChildCall: () => {},
			removeChildCall: () => {},
			showToast: () => {},
			showBackgroundTask: () => {},
			updateBackgroundTask: () => {},
			syncPendingQueue: () => [],
		},
		tui: { requestRender: () => {} },
		t: {
			primaryFg: { ansi16: 37 },
			secondaryFg: { ansi16: 36 },
			mutedFg: { ansi16: 90 },
			accentFg: { ansi16: 95 },
			brightFg: { ansi16: 95 },
			okFg: { ansi16: 32 },
			warnFg: { ansi16: 33 },
			errFg: { ansi16: 31 },
			userFg: { ansi16: 37 },
			agentFg: { ansi16: 36 },
			userBg: { ansi16: 0 },
			agentBg: { ansi16: 0 },
		},
		session: { state: { id: "test", modelId: "test", contextWindow: 200000 }, cancelToolCall: () => {} },
	};
}

function snapshot(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
	return {
		descriptor: {
			taskId: "task-1",
			profile: "explore",
			actorAddress: "@planner",
			planId: "plan-1",
			stepId: "step-1",
			discourseTopic: "plan",
			discourseThread: "plan-1",
			work: {
				role: { category: "line", laneId: "dev", roleId: "implementer" },
				owner: { actorAddress: "@planner", roleId: "owner" },
				group: { id: "ptp-dev", category: "cross_functional", domainId: "ptp" },
			},
			modelId: "claude-sonnet",
			attempt: 1,
		},
		status: "running",
		startedAt: 1000,
		lastActivityAt: 1500,
		...overrides,
	};
}

describe("task ledger reducer", { tags: ["unit"] }, () => {
	it("task-started creates a durable ledger entry", () => {
		const ui = noopUi();
		const state = dispatchEvent(initialDispatchState(), { type: "task-started", task: snapshot() }, ui);
		const task = state.taskLedger.get("task-1");
		expect(task?.profile).toBe("explore");
		expect(task?.ownerAddress).toBe("@planner");
		expect(task?.planId).toBe("plan-1");
		expect(task?.work?.role?.laneId).toBe("dev");
		expect(task?.status).toBe("running");
	});

	it("task-progress creates the entry if the start signal was missed", () => {
		const ui = noopUi();
		const state = dispatchEvent(
			initialDispatchState(),
			{ type: "task-progress", task: snapshot(), chunk: "searching..." },
			ui,
		);
		const task = state.taskLedger.get("task-1");
		expect(task?.chunkTail).toEqual(["searching..."]);
		expect(task?.status).toBe("running");
	});

	it("chunkless completion remains inspectable", () => {
		const ui = noopUi();
		const completed = snapshot({
			status: "completed",
			completedAt: 3000,
			lastActivityAt: 3000,
			reply: "done",
		});
		const state = dispatchEvent(
			initialDispatchState(),
			{ type: "task-completed", task: completed, reply: "done", elapsedMs: 2000 },
			ui,
		);
		const task = state.taskLedger.get("task-1");
		expect(task?.status).toBe("completed");
		expect(task?.reply).toBe("done");
		expect(task?.completedAt).toBe(3000);
	});

	it("task-cancelled keeps the ledger entry and error", () => {
		const ui = noopUi();
		const started = dispatchEvent(initialDispatchState(), { type: "task-started", task: snapshot() }, ui);
		const cancelled = snapshot({
			status: "cancelled",
			completedAt: 2500,
			lastActivityAt: 2500,
			error: "Task cancelled",
		});
		const state = dispatchEvent(
			started,
			{ type: "task-cancelled", task: cancelled, error: "Task cancelled", elapsedMs: 1500 },
			ui,
		);
		const task = state.taskLedger.get("task-1");
		expect(task?.status).toBe("cancelled");
		expect(task?.error).toBe("Task cancelled");
	});
});
