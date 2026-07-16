import type { DiscussionState, TaskSnapshot, WorkContext } from "@dpopsuev/alef-kernel/execution";

/** Minimal plan-step shape accepted by the factory world projector. */
export interface FactoryPlanStepInput {
	id: string;
	label?: string;
	status: string;
	claim?: {
		owner?: string;
		state?: string;
	};
	result?: string;
}

/** Minimal plan shape accepted by the factory world projector. */
export interface FactoryPlanInput {
	id: string;
	phase: string;
	current: string;
	desired: string;
	verify?: string;
	updatedAt?: number;
	summary?: string;
	steps: FactoryPlanStepInput[];
}

/** Workflow runtime snapshot accepted by the factory world projector. */
export interface FactoryWorkflowInput {
	id: string;
	name?: string;
	status: "running" | "completed" | "failed" | "escalated";
	eventType?: string;
	step?: string;
	retries?: number;
	score?: number;
	updatedAt?: number;
}

/** Inputs needed to build an Alef-native world snapshot. */
export interface FactoryWorldInput {
	discussion?: DiscussionState;
	plans?: readonly FactoryPlanInput[];
	tasks?: readonly TaskSnapshot[];
	workflows?: readonly FactoryWorkflowInput[];
}

/** Canonical discussion projection for the world snapshot. */
export interface FactoryDiscussionProjection {
	home: string;
	active: string;
	subscriptions: string[];
}

/** Reduced plan view for factory orchestration and UI projection. */
export interface FactoryPlanProjection {
	id: string;
	phase: string;
	current: string;
	desired: string;
	verify?: string;
	updatedAt?: number;
	summary?: string;
	totalSteps: number;
	doneSteps: number;
	activeStepId?: string;
	readyStepIds: string[];
}

/** Reduced task view for world-model consumers. */
export interface FactoryTaskProjection {
	taskId: string;
	status: TaskSnapshot["status"];
	profile: string;
	updatedAt: number;
	ownerAddress?: string;
	planId?: string;
	stepId?: string;
	discussion?: string;
	work?: WorkContext;
	preview?: string;
}

/** Aggregated staffing slice grouped by role and line. */
export interface FactoryLineProjection {
	key: string;
	kind: string;
	roleId: string;
	lineId?: string;
	taskIds: string[];
}

/** Aggregated work-cell slice grouped by cell id. */
export interface FactoryCellProjection {
	id: string;
	kind: string;
	productId?: string;
	missionId?: string;
	taskIds: string[];
	planIds: string[];
}

/** Cross-reference indexes for navigating the world snapshot. */
export interface FactoryWorldIndex {
	byPlan: Record<string, string[]>;
	byStep: Record<string, string[]>;
	byDiscussion: Record<string, string[]>;
}

/** Alef-native world snapshot over plans, discussion, tasks, and workflow runtime. */
export interface FactoryWorldModel {
	generatedAt: number;
	discussion?: FactoryDiscussionProjection;
	plans: FactoryPlanProjection[];
	tasks: FactoryTaskProjection[];
	workflows: FactoryWorkflowInput[];
	lines: FactoryLineProjection[];
	cells: FactoryCellProjection[];
	index: FactoryWorldIndex;
}

const TASK_PREVIEW_LIMIT = 120;

/**
 *
 */
function discussionKey(forumId: string, topicId: string): string {
	return `${forumId}/${topicId}`;
}

/**
 *
 */
function previewForTask(task: TaskSnapshot): string | undefined {
	return task.reply?.slice(0, TASK_PREVIEW_LIMIT) ?? task.error?.slice(0, TASK_PREVIEW_LIMIT);
}

/**
 *
 */
function ensureIndexEntry(index: Record<string, string[]>, key: string, value: string): void {
	const existing = index[key] ?? [];
	if (!existing.includes(value)) existing.push(value);
	index[key] = existing;
}

/**
 *
 */
function projectDiscussion(discussion: DiscussionState | undefined): FactoryDiscussionProjection | undefined {
	if (!discussion) return undefined;
	return {
		home: discussionKey(discussion.home.forumId, discussion.home.topicId),
		active: discussionKey(discussion.active.forumId, discussion.active.topicId),
		subscriptions: discussion.subscriptions.map((entry) =>
			discussionKey(entry.discussion.forumId, entry.discussion.topicId),
		),
	};
}

/**
 *
 */
function projectPlans(plans: readonly FactoryPlanInput[]): FactoryPlanProjection[] {
	return plans.map((plan) => {
		const doneSteps = plan.steps.filter((step) => step.status === "done" || step.status === "completed").length;
		const activeStep = plan.steps.find((step) => step.status === "active");
		const readySteps = plan.steps
			.filter((step) => step.status === "pending" || step.status === "ready")
			.map((step) => step.id);
		return {
			id: plan.id,
			phase: plan.phase,
			current: plan.current,
			desired: plan.desired,
			verify: plan.verify,
			updatedAt: plan.updatedAt,
			summary: plan.summary,
			totalSteps: plan.steps.length,
			doneSteps,
			activeStepId: activeStep?.id,
			readyStepIds: readySteps,
		};
	});
}

/**
 *
 */
function projectTasks(
	tasks: readonly TaskSnapshot[],
	index: FactoryWorldIndex,
): FactoryTaskProjection[] {
	return tasks.map((task) => {
		if (task.descriptor.planId) {
			ensureIndexEntry(index.byPlan, task.descriptor.planId, task.descriptor.taskId);
		}
		if (task.descriptor.stepId) {
			ensureIndexEntry(index.byStep, task.descriptor.stepId, task.descriptor.taskId);
		}
		if (task.descriptor.discourseTopic && task.descriptor.discourseThread) {
			ensureIndexEntry(
				index.byDiscussion,
				discussionKey(task.descriptor.discourseTopic, task.descriptor.discourseThread),
				task.descriptor.taskId,
			);
		}
		return {
			taskId: task.descriptor.taskId,
			status: task.status,
			profile: task.descriptor.profile,
			updatedAt: task.completedAt ?? task.lastActivityAt,
			ownerAddress: task.descriptor.actorAddress,
			planId: task.descriptor.planId,
			stepId: task.descriptor.stepId,
			discussion:
				task.descriptor.discourseTopic && task.descriptor.discourseThread
					? discussionKey(task.descriptor.discourseTopic, task.descriptor.discourseThread)
					: undefined,
			work: task.descriptor.work,
			preview: previewForTask(task),
		};
	});
}

/**
 *
 */
function aggregateLines(tasks: readonly FactoryTaskProjection[]): FactoryLineProjection[] {
	const grouped = new Map<string, FactoryLineProjection>();
	for (const task of tasks) {
		const role = task.work?.role;
		if (!role) continue;
		const key = `${role.category}:${role.laneId ?? "-"}:${role.roleId}`;
		const existing = grouped.get(key);
		if (existing) {
			existing.taskIds.push(task.taskId);
			continue;
		}
		grouped.set(key, {
			key,
			kind: role.category,
			roleId: role.roleId,
			lineId: role.laneId,
			taskIds: [task.taskId],
		});
	}
	return [...grouped.values()].sort((left, right) => left.key.localeCompare(right.key));
}

/**
 *
 */
function aggregateCells(tasks: readonly FactoryTaskProjection[]): FactoryCellProjection[] {
	const grouped = new Map<string, FactoryCellProjection>();
	for (const task of tasks) {
		const group = task.work?.group;
		if (!group) continue;
		const existing = grouped.get(group.id);
		if (existing) {
			existing.taskIds.push(task.taskId);
			if (task.planId && !existing.planIds.includes(task.planId)) existing.planIds.push(task.planId);
			continue;
		}
		grouped.set(group.id, {
			id: group.id,
			kind: group.category,
			productId: group.domainId,
			missionId: group.objectiveId,
			taskIds: [task.taskId],
			planIds: task.planId ? [task.planId] : [],
		});
	}
	return [...grouped.values()].sort((left, right) => left.id.localeCompare(right.id));
}

/** Build an Alef-native factory world snapshot from current runtime state. */
export function buildFactoryWorldModel(input: FactoryWorldInput): FactoryWorldModel {
	const index: FactoryWorldIndex = { byPlan: {}, byStep: {}, byDiscussion: {} };
	const plans = projectPlans(input.plans ?? []);
	const tasks = projectTasks(input.tasks ?? [], index);
	return {
		generatedAt: Date.now(),
		discussion: projectDiscussion(input.discussion),
		plans,
		tasks,
		workflows: [...(input.workflows ?? [])],
		lines: aggregateLines(tasks),
		cells: aggregateCells(tasks),
		index,
	};
}

/** Condensed text summary for context injection or UI badges. */
export function summarizeFactoryWorld(model: FactoryWorldModel): string {
	const planCount = model.plans.length;
	const activePlans = model.plans.filter((plan) => plan.phase !== "closed").length;
	const runningTasks = model.tasks.filter((task) => task.status === "running").length;
	const runningWorkflows = model.workflows.filter((workflow) => workflow.status === "running").length;
	const lines = [
		`plans=${planCount} active=${activePlans}`,
		`tasks=${model.tasks.length} running=${runningTasks}`,
		`workflows=${model.workflows.length} running=${runningWorkflows}`,
		`lines=${model.lines.length}`,
		`cells=${model.cells.length}`,
	];
	if (model.discussion) {
		lines.push(`discussion=${model.discussion.active}`);
	}
	return lines.join(" · ");
}
