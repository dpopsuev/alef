import type { BusMessage } from "@dpopsuev/alef-kernel/bus";
import { describe, expect, it } from "vitest";
import { signalToAgentEvent } from "../src/assemble.js";

function msg(type: string, payload: Record<string, unknown> = {}): BusMessage {
	return { type, correlationId: "c-1", timestamp: Date.now(), payload } as BusMessage & {
		payload: Record<string, unknown>;
	};
}

function taskSnapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		descriptor: {
			taskId: "t-1",
			profile: "coding",
			actorAddress: "@planner",
			planId: "plan-1",
			stepId: "step-1",
			discourseTopic: "plan",
			discourseThread: "plan-1",
			work: {
				role: { category: "staff", roleId: "gensec", blueprintId: "gensec" },
				owner: { actorAddress: "@planner", roleId: "coordination-owner" },
				group: { id: "ptp-factory", category: "mission", domainId: "ptp", objectiveId: "staffed-runtime" },
			},
			attempt: 1,
		},
		status: "running",
		startedAt: 1000,
		lastActivityAt: 1500,
		...overrides,
	};
}

describe("signalToAgentEvent — bus→AgentEvent bridge", { tags: ["unit"] }, () => {
	it("llm.chunk → chunk with text", () => {
		const result = signalToAgentEvent(msg("llm.chunk", { text: "hello" }));
		expect(result).toEqual({ type: "chunk", text: "hello" });
	});

	it("llm.chunk with non-string text defaults to empty", () => {
		const result = signalToAgentEvent(msg("llm.chunk", { text: 42 }));
		expect(result).toEqual({ type: "chunk", text: "" });
	});

	it("llm.thinking → thinking with text", () => {
		const result = signalToAgentEvent(msg("llm.thinking", { text: "reasoning..." }));
		expect(result).toEqual({ type: "thinking", text: "reasoning..." });
	});

	it("llm.tool-start → tool-start with callId, name, args", () => {
		const result = signalToAgentEvent(msg("llm.tool-start", {
			callId: "call-1", name: "fs.read", args: { path: "a.ts" },
		}));
		expect(result).toEqual({
			type: "tool-start",
			callId: "call-1",
			name: "fs.read",
			args: { path: "a.ts" },
		});
	});

	it("llm.tool-end → tool-end with ok, elapsedMs, display", () => {
		const result = signalToAgentEvent(msg("llm.tool-end", {
			callId: "call-1", elapsedMs: 150, ok: true, display: "file content", displayKind: "text/plain",
		}));
		expect(result).toEqual({
			type: "tool-end",
			callId: "call-1",
			elapsedMs: 150,
			ok: true,
			display: "file content",
			displayKind: "text/plain",
		});
	});

	it("llm.tool-end without display fields → undefined", () => {
		const result = signalToAgentEvent(msg("llm.tool-end", {
			callId: "call-1", elapsedMs: 50, ok: false,
		}));
		expect(result).toMatchObject({ type: "tool-end", display: undefined, displayKind: undefined });
	});

	it("llm.tool-chunk → tool-chunk with callId and text", () => {
		const result = signalToAgentEvent(msg("llm.tool-chunk", { callId: "call-1", text: "partial" }));
		expect(result).toEqual({ type: "tool-chunk", callId: "call-1", text: "partial" });
	});

	it("llm.tool-stall → tool-stall with timing", () => {
		const result = signalToAgentEvent(msg("llm.tool-stall", {
			callId: "call-1", name: "shell.exec", elapsedMs: 5000, lastChunkMs: 3000,
		}));
		expect(result).toEqual({
			type: "tool-stall",
			callId: "call-1",
			name: "shell.exec",
			elapsedMs: 5000,
			lastChunkMs: 3000,
		});
	});

	it("llm.tool-validation-error → tool-validation-error", () => {
		const result = signalToAgentEvent(msg("llm.tool-validation-error", {
			callId: "call-1", field: "path", message: "required",
		}));
		expect(result).toEqual({
			type: "tool-validation-error",
			callId: "call-1",
			field: "path",
			message: "required",
		});
	});

	it("llm.token-usage → token-usage with usage object", () => {
		const usage = { input: 100, output: 50 };
		const result = signalToAgentEvent(msg("llm.token-usage", { usage }));
		expect(result).toEqual({ type: "token-usage", usage });
	});

	it("llm.turn-error → turn-error with message", () => {
		const result = signalToAgentEvent(msg("llm.turn-error", { message: "rate limited" }));
		expect(result).toEqual({ type: "turn-error", message: "rate limited" });
	});

	it("llm.message-queued → message-queued with queueLength and text", () => {
		const result = signalToAgentEvent(msg("llm.message-queued", { queueLength: 3, text: "hello" }));
		expect(result).toEqual({ type: "message-queued", queueLength: 3, text: "hello" });
	});

	it("llm.message-queued → message-queued includes mode", () => {
		const result = signalToAgentEvent(
			msg("llm.message-queued", { queueLength: 1, text: "hi", mode: "steer" }),
		);
		expect(result).toEqual({ type: "message-queued", queueLength: 1, text: "hi", mode: "steer" });
	});

	it("agent.run.inner with agent.identity → subagent-identity", () => {
		const result = signalToAgentEvent(msg("agent.run.inner", {
			callId: "call-1", innerType: "agent.identity",
			innerPayload: { color: "crimson", address: "@crimson" },
		}));
		expect(result).toEqual({
			type: "subagent-identity",
			callId: "call-1",
			color: "crimson",
			address: "@crimson",
		});
	});

	it("agent.run.inner with subagent-token-usage → subagent-token-usage", () => {
		const result = signalToAgentEvent(msg("agent.run.inner", {
			callId: "call-1",
			innerType: "subagent-token-usage",
			innerPayload: { input: 123, output: 45 },
		}));
		expect(result).toEqual({
			type: "subagent-token-usage",
			callId: "call-1",
			input: 123,
			output: 45,
		});
	});

	it("agent.run.inner with llm.tool-start → inner-tool-start", () => {
		const result = signalToAgentEvent(msg("agent.run.inner", {
			callId: "parent-1", innerType: "llm.tool-start",
			innerPayload: { callId: "inner-1", name: "fs.read", args: { path: "b.ts" } },
		}));
		expect(result).toEqual({
			type: "inner-tool-start",
			parentCallId: "parent-1",
			callId: "inner-1",
			name: "fs.read",
			args: { path: "b.ts" },
		});
	});

	it("agent.run.inner with llm.tool-end → inner-tool-end", () => {
		const result = signalToAgentEvent(msg("agent.run.inner", {
			callId: "parent-1", innerType: "llm.tool-end",
			innerPayload: { callId: "inner-1" },
		}));
		expect(result).toEqual({ type: "inner-tool-end", parentCallId: "parent-1", callId: "inner-1" });
	});

	it("agent.run.inner with llm.chunk → inner-chunk", () => {
		const result = signalToAgentEvent(msg("agent.run.inner", {
			callId: "parent-1", innerType: "llm.chunk",
			innerPayload: { text: "inner text" },
		}));
		expect(result).toEqual({ type: "inner-chunk", parentCallId: "parent-1", text: "inner text" });
	});

	it("agent.run.inner without callId → null", () => {
		const result = signalToAgentEvent(msg("agent.run.inner", { innerType: "llm.chunk" }));
		expect(result).toBeNull();
	});

	it("agent.run.inner with llm.tool-stall → null (suppressed)", () => {
		const result = signalToAgentEvent(msg("agent.run.inner", {
			callId: "parent-1", innerType: "llm.tool-stall",
			innerPayload: { callId: "inner-1", name: "shell.exec", elapsedMs: 5000, lastChunkMs: 3000 },
		}));
		expect(result).toBeNull();
	});

	it("agent.run.inner with unknown innerType → null", () => {
		const result = signalToAgentEvent(msg("agent.run.inner", {
			callId: "c-1", innerType: "unknown.event", innerPayload: {},
		}));
		expect(result).toBeNull();
	});

	it("workflow.step → workflow-step", () => {
		const result = signalToAgentEvent(msg("workflow.step", {
			workflowId: "wf-1", eventType: "search", step: "find", status: "running", score: 0.9,
		}));
		expect(result).toEqual({
			type: "workflow-step",
			workflowId: "wf-1",
			eventType: "search",
			step: "find",
			status: "running",
			score: 0.9,
		});
	});

	it("workflow.completed → workflow-completed", () => {
		const result = signalToAgentEvent(msg("workflow.completed", { workflowId: "wf-1", elapsedMs: 5000 }));
		expect(result).toEqual({ type: "workflow-completed", workflowId: "wf-1", elapsedMs: 5000 });
	});

	it("workflow.error → workflow-error", () => {
		const result = signalToAgentEvent(msg("workflow.error", {
			workflowId: "wf-1", step: "verify", error: "assertion failed",
		}));
		expect(result).toEqual({
			type: "workflow-error",
			workflowId: "wf-1",
			step: "verify",
			error: "assertion failed",
		});
	});

	it("workflow.escalated → workflow-escalated", () => {
		const result = signalToAgentEvent(msg("workflow.escalated", {
			workflowId: "wf-1", rule: "retry-limit", retries: 3, score: 0.2,
		}));
		expect(result).toEqual({
			type: "workflow-escalated",
			workflowId: "wf-1",
			rule: "retry-limit",
			retries: 3,
			score: 0.2,
		});
	});

	it("task.started → task-started", () => {
		const task = taskSnapshot();
		const result = signalToAgentEvent(msg("task.started", { task }));
		expect(result).toEqual({ type: "task-started", task });
	});

	it("task.progress → task-progress", () => {
		const task = taskSnapshot();
		const result = signalToAgentEvent(msg("task.progress", { task, chunk: "searching..." }));
		expect(result).toEqual({
			type: "task-progress",
			task,
			chunk: "searching...",
		});
	});

	it("task.completed → task-completed", () => {
		const task = taskSnapshot({ status: "completed", completedAt: 4000, reply: "done" });
		const result = signalToAgentEvent(msg("task.completed", { task, reply: "done", elapsedMs: 3000 }));
		expect(result).toEqual({
			type: "task-completed",
			task,
			reply: "done",
			elapsedMs: 3000,
		});
	});

	it("task.failed → task-failed", () => {
		const task = taskSnapshot({ status: "failed", completedAt: 61_000, error: "timeout" });
		const result = signalToAgentEvent(msg("task.failed", { task, error: "timeout", elapsedMs: 60000 }));
		expect(result).toEqual({
			type: "task-failed",
			task,
			error: "timeout",
			elapsedMs: 60000,
		});
	});

	it("task.cancelled → task-cancelled", () => {
		const task = taskSnapshot({ status: "cancelled", completedAt: 5000, error: "Task cancelled" });
		const result = signalToAgentEvent(msg("task.cancelled", { task, error: "Task cancelled", elapsedMs: 4000 }));
		expect(result).toEqual({
			type: "task-cancelled",
			task,
			error: "Task cancelled",
			elapsedMs: 4000,
		});
	});

	it("unknown type → null (no mappers)", () => {
		const result = signalToAgentEvent(msg("unknown.event", { data: 1 }));
		expect(result).toBeNull();
	});

	it("unknown type with signalMapper → adapter-signal", () => {
		const mappers = new Map([["custom.signal", (p: Record<string, unknown>) => ({ value: p.data })]]);
		const result = signalToAgentEvent(msg("custom.signal", { data: 42 }), mappers);
		expect(result).toEqual({ type: "adapter-signal", signalType: "custom.signal", payload: { value: 42 } });
	});

	it("unknown type with mapper returning null → null", () => {
		const mappers = new Map([["custom.signal", () => null]]);
		const result = signalToAgentEvent(msg("custom.signal", { data: 42 }), mappers);
		expect(result).toBeNull();
	});

	it("unknown type in uiSignalTypes → adapter-signal with raw payload", () => {
		const uiTypes = new Set(["ui.custom"]);
		const result = signalToAgentEvent(msg("ui.custom", { key: "val" }), undefined, uiTypes);
		expect(result).toEqual({ type: "adapter-signal", signalType: "ui.custom", payload: { key: "val" } });
	});
});
