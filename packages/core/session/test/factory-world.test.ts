import { describe, expect, it } from "vitest";
import type { DiscussionState, TaskSnapshot } from "@dpopsuev/alef-kernel/execution";
import { buildFactoryWorldModel, summarizeFactoryWorld, type FactoryPlanInput, type FactoryWorkflowInput } from "../src/context/factory-world.js";

function sampleDiscussion(): DiscussionState {
	return {
		home: { forumId: "workspace", topicId: "home", topicTitle: "Home" },
		active: { forumId: "workspace", topicId: "ptp", topicTitle: "PTP" },
		subscriptions: [
			{
				discussion: { forumId: "workspace", topicId: "home", topicTitle: "Home" },
				subscribedAt: 1,
				mode: "participate",
				auto: true,
			},
			{
				discussion: { forumId: "workspace", topicId: "ptp", topicTitle: "PTP" },
				subscribedAt: 2,
				mode: "watch",
			},
		],
	};
}

function samplePlans(): FactoryPlanInput[] {
	return [
		{
			id: "plan-1",
			phase: "working",
			current: "triaging",
			desired: "close the staffed runtime gap",
			verify: "projection available",
			updatedAt: 123,
			steps: [
				{ id: "shape-contracts", status: "done" },
				{ id: "project-world", status: "active" },
				{ id: "wire-runtime", status: "pending" },
			],
		},
	];
}

function sampleTasks(): TaskSnapshot[] {
	return [
		{
			descriptor: {
				taskId: "task-1",
				profile: "general",
				actorAddress: "@gensec",
				planId: "plan-1",
				stepId: "project-world",
				discourseTopic: "workspace",
				discourseThread: "ptp",
				work: {
					role: { category: "staff", roleId: "gensec", blueprintId: "gensec" },
					owner: { actorAddress: "@gensec", roleId: "coordinator" },
					group: { id: "ptp-factory", category: "mission", domainId: "ptp", objectiveId: "world-model" },
				},
			},
			status: "running",
			startedAt: 100,
			lastActivityAt: 250,
		},
		{
			descriptor: {
				taskId: "task-2",
				profile: "explore",
				actorAddress: "@triager",
				planId: "plan-1",
				stepId: "project-world",
				discourseTopic: "workspace",
				discourseThread: "ptp",
				work: {
					role: { category: "line", laneId: "qe", roleId: "triage" },
					owner: { actorAddress: "@triager", roleId: "triage-owner" },
					group: { id: "ptp-factory", category: "mission", domainId: "ptp", objectiveId: "world-model" },
				},
			},
			status: "completed",
			startedAt: 110,
			lastActivityAt: 300,
			completedAt: 350,
			reply: "projected the current runtime seams",
		},
	];
}

function sampleWorkflows(): FactoryWorkflowInput[] {
	return [{ id: "wf-1", name: "staff-runtime", status: "running", step: "project-world", updatedAt: 400 }];
}

describe("factory world projection", { tags: ["unit"] }, () => {
	it("builds a unified Alef-native snapshot over discussion, plans, tasks, and workflows", () => {
		const model = buildFactoryWorldModel({
			discussion: sampleDiscussion(),
			plans: samplePlans(),
			tasks: sampleTasks(),
			workflows: sampleWorkflows(),
		});

		expect(model.discussion).toEqual({
			home: "workspace/home",
			active: "workspace/ptp",
			subscriptions: ["workspace/home", "workspace/ptp"],
		});
		expect(model.plans).toEqual([
			{
				id: "plan-1",
				phase: "working",
				current: "triaging",
				desired: "close the staffed runtime gap",
				verify: "projection available",
				updatedAt: 123,
				summary: undefined,
				totalSteps: 3,
				doneSteps: 1,
				activeStepId: "project-world",
				readyStepIds: ["wire-runtime"],
			},
		]);
		expect(model.tasks).toHaveLength(2);
		expect(model.lines).toEqual([
			{ key: "line:qe:triage", kind: "line", lineId: "qe", roleId: "triage", taskIds: ["task-2"] },
			{ key: "staff:-:gensec", kind: "staff", lineId: undefined, roleId: "gensec", taskIds: ["task-1"] },
		]);
		expect(model.cells).toEqual([
			{
				id: "ptp-factory",
				kind: "mission",
				productId: "ptp",
				missionId: "world-model",
				taskIds: ["task-1", "task-2"],
				planIds: ["plan-1"],
			},
		]);
		expect(model.index).toEqual({
			byPlan: { "plan-1": ["task-1", "task-2"] },
			byStep: { "project-world": ["task-1", "task-2"] },
			byDiscussion: { "workspace/ptp": ["task-1", "task-2"] },
		});
	});

	it("summarizes the projected world in one compact line", () => {
		const model = buildFactoryWorldModel({
			discussion: sampleDiscussion(),
			plans: samplePlans(),
			tasks: sampleTasks(),
			workflows: sampleWorkflows(),
		});

		expect(summarizeFactoryWorld(model)).toBe(
			"plans=1 active=1 · tasks=2 running=1 · workflows=1 running=1 · lines=2 · cells=1 · discussion=workspace/ptp",
		);
	});
});
