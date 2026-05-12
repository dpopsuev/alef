import type {
	AgentCapacity,
	BudgetStatusSnapshot,
	ChildAgentSummary,
	DiscourseTopic,
} from "../../../coding-agent/src/core/platform/types.js";

export type SchedulerDecisionType = "spawn" | "keep_alive" | "sleep" | "drain" | "archive" | "throttle" | "abort";

export interface SchedulerDecision {
	type: SchedulerDecisionType;
	reason: string;
	topicId: string;
	runtimeId?: string;
}

export function deriveTopicLifecycleFromRuntimes(
	runtimes: ReadonlyArray<ChildAgentSummary>,
): ChildAgentSummary["status"] | undefined {
	if (runtimes.length === 0) {
		return undefined;
	}
	if (runtimes.some((runtime) => runtime.status === "draining")) {
		return "draining";
	}
	if (runtimes.some((runtime) => runtime.status === "running")) {
		return "running";
	}
	if (runtimes.some((runtime) => runtime.status === "error")) {
		return "error";
	}
	if (runtimes.some((runtime) => runtime.status === "sleep")) {
		return "sleep";
	}
	if (runtimes.some((runtime) => runtime.status === "idle")) {
		return "idle";
	}
	if (runtimes.some((runtime) => runtime.status === "waiting")) {
		return "waiting";
	}
	return "archived";
}

export class DiscourseScheduler {
	evaluateTopic(input: {
		topic: DiscourseTopic;
		runtimes: ReadonlyArray<ChildAgentSummary>;
		capacity: AgentCapacity;
		budget: ReadonlyArray<BudgetStatusSnapshot>;
	}): SchedulerDecision[] {
		const decisions: SchedulerDecision[] = [];
		const activeRuntimes = input.runtimes.filter(
			(runtime) => runtime.status !== "archived" && runtime.status !== "error",
		);
		const blockedBudget = input.budget.find((snapshot) => snapshot.blocked);
		if (blockedBudget) {
			decisions.push({
				type: "abort",
				reason: `budget ${blockedBudget.scope}/${blockedBudget.window} is exhausted`,
				topicId: input.topic.id,
			});
			return decisions;
		}
		const throttledBudget = input.budget.find((snapshot) => snapshot.throttled);
		if (throttledBudget) {
			decisions.push({
				type: "throttle",
				reason: `budget ${throttledBudget.scope}/${throttledBudget.window} is throttled`,
				topicId: input.topic.id,
			});
			return decisions;
		}
		if (
			input.topic.lifecycle === "archived" ||
			input.topic.status === "resolved" ||
			input.topic.status === "cancelled"
		) {
			for (const runtime of activeRuntimes) {
				decisions.push({
					type: "drain",
					reason: "topic is closed",
					topicId: input.topic.id,
					runtimeId: runtime.id,
				});
			}
			if (activeRuntimes.length === 0) {
				decisions.push({
					type: "archive",
					reason: "topic is already closed with no active runtimes",
					topicId: input.topic.id,
				});
			}
			return decisions;
		}
		if (activeRuntimes.length > 0) {
			for (const runtime of activeRuntimes) {
				decisions.push({
					type:
						runtime.status === "sleep" || runtime.status === "idle" || runtime.status === "waiting"
							? "sleep"
							: "keep_alive",
					reason: `runtime is ${runtime.status}`,
					topicId: input.topic.id,
					runtimeId: runtime.id,
				});
			}
			return decisions;
		}
		if (input.capacity.activeRuntimeIds.length >= input.capacity.maxConcurrent) {
			decisions.push({
				type: "throttle",
				reason: `capacity ${input.capacity.activeRuntimeIds.length}/${input.capacity.maxConcurrent} is full`,
				topicId: input.topic.id,
			});
			return decisions;
		}
		decisions.push({
			type: "spawn",
			reason: "topic has no active runtime and capacity is available",
			topicId: input.topic.id,
		});
		return decisions;
	}
}
