import { describe, expect, it } from "vitest";
import type { AgentDiscoursePort, ReviewBoardPort } from "../src/core/platform/index.js";
import {
	compileAgentDefinition,
	DoltBackedDiscourseStore,
	DoltBackedReviewBoard,
	InMemoryDoltStoreDriver,
} from "../src/core/platform/index.js";
import { SessionManager } from "../src/core/session-manager.js";

function createPorts(): {
	sessionManager: SessionManager;
	driver: InMemoryDoltStoreDriver;
	discourse: AgentDiscoursePort;
	review: ReviewBoardPort;
} {
	const sessionManager = SessionManager.inMemory("/tmp/project");
	const driver = new InMemoryDoltStoreDriver();
	const discourse: AgentDiscoursePort = new DoltBackedDiscourseStore(sessionManager, driver);
	const review: ReviewBoardPort = new DoltBackedReviewBoard(sessionManager, discourse, driver);
	return { sessionManager, driver, discourse, review };
}

const definition = compileAgentDefinition({
	name: "release-worker",
	organs: [{ name: "fs", actions: ["read"] }],
});

describe("Dolt discourse runtime and review projection", () => {
	it("projects runtimes, budgets, atoms, and molecules into thread views and review documents", () => {
		const { discourse, review } = createPorts();
		discourse.ensureBoard({
			boardId: "ops",
			title: "Operations",
			metadata: { repoPath: "/tmp/project" },
		});
		const topic = discourse.createTopic({
			boardId: "ops",
			forumId: "release",
			title: "Runtime review",
			address: "#ops.release.runtime-review.thread",
		});
		discourse.postLetter({
			threadId: topic.thread.id,
			author: "root",
			body: "Review the runtime handoff.",
			scope: "dialog",
		});
		discourse.registerRuntime({
			id: "runtime-1",
			name: "release-worker",
			role: "child",
			status: "waiting",
			createdAt: 1,
			updatedAt: 1,
			cwd: "/tmp/project",
			sessionId: "session-1",
			definition,
			topicId: topic.topic.id,
			threadId: topic.thread.id,
			discourseObjectId: topic.topic.id,
		});
		discourse.updateRuntime({
			runtimeId: "runtime-1",
			status: "idle",
			latestSummary: "waiting for the next batch",
		});
		discourse.updateRuntime({
			runtimeId: "runtime-1",
			status: "sleep",
			latestSummary: "handoff sealed",
		});
		const atom = discourse.createKnowledgeAtom({
			kind: "runtime-summary",
			title: "Runtime summary",
			body: "handoff sealed",
			summary: "sealed handoff",
			scope: "monolog",
			sourceType: "runtime",
			sourceId: "runtime-1",
			createdBy: "2sec",
			discourseObjectId: topic.topic.id,
			topicId: topic.topic.id,
			threadId: topic.thread.id,
			runtimeId: "runtime-1",
		});
		discourse.createKnowledgeMolecule({
			kind: "runtime-drain",
			title: "Runtime drain package",
			body: "sealed handoff",
			atomIds: [atom.id],
			sourceIds: [atom.sourceId],
			createdBy: "2sec",
			discourseObjectId: topic.topic.id,
			topicId: topic.topic.id,
			threadId: topic.thread.id,
			runtimeId: "runtime-1",
			summary: "drain output",
		});
		discourse.upsertBudgetPolicy({
			scope: "global",
			createdBy: "operator",
			day: { maxTokens: 100, warnAt: 30 },
		});
		discourse.upsertBudgetPolicy({
			scope: "agent",
			targetId: "runtime-1",
			createdBy: "operator",
			day: { maxTokens: 80, throttleAt: 35 },
		});
		discourse.upsertBudgetPolicy({
			scope: "discourse_object",
			targetId: topic.topic.id,
			createdBy: "operator",
			day: { maxTokens: 50, abortAt: 40 },
		});

		const budget = discourse.recordBudgetUsage({
			agentId: "runtime-1",
			discourseObjectId: topic.topic.id,
			inputTokens: 25,
			outputTokens: 15,
		});
		expect(budget.find((snapshot) => snapshot.scope === "global" && snapshot.window === "day")?.action).toBe("warn");
		expect(budget.find((snapshot) => snapshot.scope === "agent" && snapshot.window === "day")?.throttled).toBe(true);
		expect(
			budget.find((snapshot) => snapshot.scope === "discourse_object" && snapshot.window === "day")?.blocked,
		).toBe(true);

		const threadView = discourse.readThread({ threadId: topic.thread.id });
		expect(threadView.topic.lifecycle).toBe("sleep");
		expect(threadView.runtimes).toHaveLength(1);
		expect(threadView.runtimes[0]?.status).toBe("sleep");
		expect(threadView.atoms).toHaveLength(1);
		expect(threadView.molecules).toHaveLength(1);
		expect(threadView.budget.map((snapshot) => `${snapshot.scope}:${snapshot.action ?? "none"}`)).toContain(
			"global:warn",
		);
		expect(threadView.budget.map((snapshot) => `${snapshot.scope}:${snapshot.action ?? "none"}`)).toContain(
			"agent:throttle",
		);
		expect(threadView.budget.map((snapshot) => `${snapshot.scope}:${snapshot.action ?? "none"}`)).toContain(
			"discourse_object:abort",
		);

		const document = review.getDocumentByAddress("#ops.release.runtime-review.thread");
		expect(document?.id).toBe(topic.thread.id);
		expect(document?.nodes.some((node) => node.kind === "runtime" && node.title === "release-worker")).toBe(true);
		expect(document?.nodes.filter((node) => node.kind === "budget")).toHaveLength(3);
		expect(document?.nodes.some((node) => node.kind === "atom" && node.title === "Runtime summary")).toBe(true);
		expect(document?.nodes.some((node) => node.kind === "molecule" && node.title === "Runtime drain package")).toBe(
			true,
		);
	});

	it("releases claims, archives runtimes, and survives a store reload", () => {
		const { sessionManager, driver, discourse } = createPorts();
		discourse.ensureBoard({ boardId: "ops", title: "Operations" });
		const topic = discourse.createTopic({
			boardId: "ops",
			forumId: "release",
			title: "Archive me",
			address: "#ops.release.archive-me.thread",
		});
		discourse.postLetter({
			threadId: topic.thread.id,
			author: "root",
			body: "Close out the topic cleanly.",
			scope: "dialog",
		});
		const claim = discourse.claimTarget({
			topicId: topic.topic.id,
			claimedBy: "release-worker",
			leaseMs: 60_000,
		});
		discourse.registerRuntime({
			id: "runtime-archive",
			name: "release-worker",
			role: "child",
			status: "idle",
			createdAt: 1,
			updatedAt: 1,
			cwd: "/tmp/project",
			sessionId: "session-archive",
			definition,
			topicId: topic.topic.id,
			threadId: topic.thread.id,
			discourseObjectId: topic.topic.id,
			claimId: claim.id,
		});
		discourse.createKnowledgeAtom({
			kind: "archive-note",
			title: "Archive note",
			body: "ready to archive",
			scope: "system",
			sourceType: "thread",
			sourceId: topic.thread.id,
			createdBy: "2sec",
			discourseObjectId: topic.topic.id,
			topicId: topic.topic.id,
			threadId: topic.thread.id,
			runtimeId: "runtime-archive",
		});
		discourse.upsertBudgetPolicy({
			scope: "discourse_object",
			targetId: topic.topic.id,
			createdBy: "operator",
			day: { maxTokens: 100, informAt: 10 },
		});
		discourse.recordBudgetUsage({
			agentId: "runtime-archive",
			discourseObjectId: topic.topic.id,
			inputTokens: 8,
			outputTokens: 4,
		});

		const archived = discourse.archiveTopic({
			topicId: topic.topic.id,
			archivedBy: "operator",
			reason: "work complete",
		});
		expect(archived.topic.lifecycle).toBe("archived");
		expect(discourse.listClaims("#ops.release.archive-me.thread")[0]?.status).toBe("released");
		expect(discourse.listRuntimes(topic.topic.id)[0]?.status).toBe("archived");

		const reloadedDiscourse: AgentDiscoursePort = new DoltBackedDiscourseStore(sessionManager, driver);
		const reloadedReview: ReviewBoardPort = new DoltBackedReviewBoard(sessionManager, reloadedDiscourse, driver);
		const view = reloadedDiscourse.readThread({ address: "#ops.release.archive-me.thread" });
		expect(view.topic.lifecycle).toBe("archived");
		expect(view.thread.lifecycle).toBe("archived");
		expect(view.runtimes[0]?.status).toBe("archived");
		expect(view.atoms).toHaveLength(1);
		expect(
			view.budget.find((snapshot) => snapshot.scope === "discourse_object" && snapshot.window === "day")?.action,
		).toBe("inform");

		const document = reloadedReview.getDocumentByAddress("#ops.release.archive-me.thread");
		expect(document?.nodes.some((node) => node.kind === "runtime" && node.status === "archived")).toBe(true);
		expect(document?.nodes.some((node) => node.kind === "atom" && node.title === "Archive note")).toBe(true);
	});
});
