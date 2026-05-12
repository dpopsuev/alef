import { describe, expect, it } from "vitest";
import type {
	AgentCapacity,
	BudgetStatusSnapshot,
	ChildAgentSummary,
	CompiledAgentDefinition,
	DiscourseTopic,
} from "../src/core/platform/index.js";
import {
	compileAgentDefinition,
	DiscourseScheduler,
	deriveTopicLifecycleFromRuntimes,
} from "../src/core/platform/index.js";

const definition: CompiledAgentDefinition = compileAgentDefinition({
	name: "worker",
	organs: [{ name: "fs", actions: ["read"] }],
});

function makeTopic(overrides: Partial<DiscourseTopic> = {}): DiscourseTopic {
	return {
		id: "topic-1",
		key: "topic-1",
		address: {
			boardId: "ops",
			forumId: "release",
			topicId: "topic-1",
		},
		boardId: "board-1",
		forumId: "forum-1",
		title: "Release topic",
		status: "open",
		lifecycle: "waiting",
		threadId: "thread-1",
		createdAt: 1,
		updatedAt: 1,
		labels: [],
		originForumId: "forum-1",
		originForumKey: "release",
		currentForumId: "forum-1",
		routingState: "scoped",
		...overrides,
	};
}

function makeRuntime(
	status: ChildAgentSummary["status"],
	overrides: Partial<ChildAgentSummary> = {},
): ChildAgentSummary {
	const id = overrides.id ?? `runtime-${status}`;
	return {
		id,
		name: `worker-${status}`,
		role: "child",
		status,
		createdAt: 1,
		updatedAt: 1,
		cwd: "/tmp/project",
		sessionId: `${id}-session`,
		definition,
		topicId: "topic-1",
		threadId: "thread-1",
		discourseObjectId: "topic-1",
		...overrides,
	};
}

function makeCapacity(overrides: Partial<AgentCapacity> = {}): AgentCapacity {
	return {
		id: "capacity-1",
		maxConcurrent: 2,
		activeRuntimeIds: [],
		updatedAt: 1,
		...overrides,
	};
}

function makeBudget(overrides: Partial<BudgetStatusSnapshot> = {}): BudgetStatusSnapshot {
	return {
		scope: "discourse_object",
		targetId: "topic-1",
		window: "day",
		bucket: "2026-05-11",
		maxTokens: 100,
		usedTokens: 0,
		remainingTokens: 100,
		action: undefined,
		throttled: false,
		blocked: false,
		...overrides,
	};
}

describe("DiscourseScheduler", () => {
	it("derives topic lifecycle from runtime priority", () => {
		expect(deriveTopicLifecycleFromRuntimes([])).toBeUndefined();
		expect(deriveTopicLifecycleFromRuntimes([makeRuntime("waiting"), makeRuntime("idle")])).toBe("idle");
		expect(deriveTopicLifecycleFromRuntimes([makeRuntime("running"), makeRuntime("sleep")])).toBe("running");
		expect(deriveTopicLifecycleFromRuntimes([makeRuntime("error"), makeRuntime("draining")])).toBe("draining");
		expect(deriveTopicLifecycleFromRuntimes([makeRuntime("archived")])).toBe("archived");
	});

	it("spawns when an open topic has no active runtime and capacity is available", () => {
		const scheduler = new DiscourseScheduler();
		expect(
			scheduler.evaluateTopic({
				topic: makeTopic(),
				runtimes: [],
				capacity: makeCapacity(),
				budget: [],
			}),
		).toEqual([
			{
				type: "spawn",
				reason: "topic has no active runtime and capacity is available",
				topicId: "topic-1",
			},
		]);
	});

	it("keeps running runtimes alive and parks waiting or sleeping ones", () => {
		const scheduler = new DiscourseScheduler();
		expect(
			scheduler.evaluateTopic({
				topic: makeTopic({ lifecycle: "running", status: "running" }),
				runtimes: [makeRuntime("running"), makeRuntime("waiting", { id: "runtime-2" })],
				capacity: makeCapacity({ activeRuntimeIds: ["runtime-running", "runtime-2"] }),
				budget: [],
			}),
		).toEqual([
			{
				type: "keep_alive",
				reason: "runtime is running",
				topicId: "topic-1",
				runtimeId: "runtime-running",
			},
			{
				type: "sleep",
				reason: "runtime is waiting",
				topicId: "topic-1",
				runtimeId: "runtime-2",
			},
		]);
	});

	it("throttles on capacity pressure and budget throttle, and aborts on exhausted budgets", () => {
		const scheduler = new DiscourseScheduler();
		expect(
			scheduler.evaluateTopic({
				topic: makeTopic(),
				runtimes: [],
				capacity: makeCapacity({ maxConcurrent: 1, activeRuntimeIds: ["runtime-1"] }),
				budget: [],
			})[0],
		).toMatchObject({
			type: "throttle",
			reason: "capacity 1/1 is full",
		});

		expect(
			scheduler.evaluateTopic({
				topic: makeTopic(),
				runtimes: [],
				capacity: makeCapacity(),
				budget: [makeBudget({ action: "throttle", throttled: true, usedTokens: 76, remainingTokens: 24 })],
			})[0],
		).toMatchObject({
			type: "throttle",
			reason: "budget discourse_object/day is throttled",
		});

		expect(
			scheduler.evaluateTopic({
				topic: makeTopic(),
				runtimes: [],
				capacity: makeCapacity(),
				budget: [makeBudget({ action: "abort", blocked: true, usedTokens: 100, remainingTokens: 0 })],
			})[0],
		).toMatchObject({
			type: "abort",
			reason: "budget discourse_object/day is exhausted",
		});
	});

	it("drains active runtimes for archived topics and archives closed topics without active runtimes", () => {
		const scheduler = new DiscourseScheduler();
		const closedTopic = makeTopic({ lifecycle: "archived", status: "resolved" });
		expect(
			scheduler.evaluateTopic({
				topic: closedTopic,
				runtimes: [makeRuntime("running"), makeRuntime("sleep", { id: "runtime-2" })],
				capacity: makeCapacity(),
				budget: [],
			}),
		).toEqual([
			{
				type: "drain",
				reason: "topic is closed",
				topicId: "topic-1",
				runtimeId: "runtime-running",
			},
			{
				type: "drain",
				reason: "topic is closed",
				topicId: "topic-1",
				runtimeId: "runtime-2",
			},
		]);

		expect(
			scheduler.evaluateTopic({
				topic: closedTopic,
				runtimes: [],
				capacity: makeCapacity(),
				budget: [],
			}),
		).toEqual([
			{
				type: "archive",
				reason: "topic is already closed with no active runtimes",
				topicId: "topic-1",
			},
		]);
	});
});
