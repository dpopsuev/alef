import { describe, expect, it } from "vitest";
import { boardPathToAddress } from "../src/board/types.js";
import type { AgentDiscoursePort, ReviewBoardPort } from "../src/core/platform/index.js";
import {
	DoltBackedDiscourseStore,
	DoltBackedReviewBoard,
	InMemoryDoltStoreDriver,
} from "../src/core/platform/index.js";
import { SessionManager } from "../src/core/session-manager.js";

function createPorts(): {
	discourse: AgentDiscoursePort;
	review: ReviewBoardPort;
} {
	const sessionManager = SessionManager.inMemory("/tmp/project");
	const driver = new InMemoryDoltStoreDriver();
	const discourse: AgentDiscoursePort = new DoltBackedDiscourseStore(sessionManager, driver);
	const review: ReviewBoardPort = new DoltBackedReviewBoard(sessionManager, discourse, driver);
	return { discourse, review };
}

function seedTemplateAndTopic(discourse: AgentDiscoursePort) {
	discourse.ensureBoard({
		boardId: "ops",
		title: "Operations",
		metadata: {
			repoPath: "/tmp/project",
		},
	});
	const template = discourse.createTemplate({
		boardId: "ops",
		forumId: "release",
		anchor: "Review the release candidate",
		sections: [
			{ title: "Goal", body: "Confirm readiness." },
			{ title: "Risks", body: "Enumerate blockers." },
		],
	});
	const topic = discourse.createTopic({
		title: "Release review",
		templateId: template.id,
		templateSectionIds: template.sections.map((section) => section.id),
		address: "#ops.release.topic.thread",
		labels: [{ key: "domain", value: "release", source: "system" }],
	});
	discourse.postLetter({
		address: "#ops.release.topic.thread",
		author: "root",
		body: "Start with the release blockers.",
		scope: "dialog",
	});
	return { template, topic };
}

describe("DoltBackedDiscourseStore — contract compliance", () => {
	it("keeps template aliases, board/forum scaffolding, and address read entrypoints consistent", () => {
		const { discourse } = createPorts();
		const { template, topic } = seedTemplateAndTopic(discourse);
		const stamp = discourse.requestStamp({ templateId: template.id, requestedBy: "gensec" });
		expect(stamp.decision).toBe("pending");
		expect(discourse.decideStamp({ stampId: stamp.id, decision: "approved", decidedBy: "operator" }).decision).toBe(
			"approved",
		);

		expect(discourse.getBoard("ops")?.title).toBe("Operations");
		expect(discourse.listForums("ops").some((forum) => forum.key === "general")).toBe(true);
		expect(discourse.getTemplate(template.id)?.id).toBe(template.id);
		expect(discourse.getContract(template.id)?.id).toBe(template.id);
		expect(discourse.approveContract({ contractId: template.id }).status).toBe("active");
		expect(
			discourse.rejectTemplate({ templateId: template.id, approvedBy: "operator", input: "Missing sign-off." })
				.status,
		).toBe("rejected");

		const byTopic = discourse.readThread({ topicId: topic.topic.id });
		const byThread = discourse.readThread({ threadId: topic.thread.id });
		const byAddress = discourse.readThread({ address: "#ops.release.topic.thread" });
		expect(byTopic.thread.id).toBe(byThread.thread.id);
		expect(byTopic.thread.id).toBe(byAddress.thread.id);
		expect(byAddress.board?.key).toBe("ops");
		expect(byAddress.forum?.key).toBe("release");
		expect(discourse.getForum("release")?.boardId).toBe(byAddress.board?.id);
		expect(discourse.getTopicByAddress("#ops.release.topic")?.id).toBe(topic.topic.id);
		expect(discourse.getThreadByAddress("#ops.release.topic.thread")?.id).toBe(topic.thread.id);
	});

	it("returns template-filtered topic summaries with latest letters", () => {
		const { discourse } = createPorts();
		const { template } = seedTemplateAndTopic(discourse);

		const summaries = discourse.listTopics(template.id);
		expect(summaries).toHaveLength(1);
		expect(summaries[0]?.template?.id).toBe(template.id);
		expect(summaries[0]?.contract?.id).toBe(template.id);
		expect(summaries[0]?.board?.key).toBe("ops");
		expect(summaries[0]?.forum?.key).toBe("release");
		expect(summaries[0]?.latestLetter?.body).toBe("Start with the release blockers.");
	});

	it("claims targets by selector with lease semantics distinct from assignment", () => {
		const { discourse } = createPorts();
		const { topic } = seedTemplateAndTopic(discourse);

		const claim = discourse.claimTarget({
			claimedBy: "review-agent",
			labelSelectors: ["forum:release", "domain:release"],
			leaseMs: 1_000,
		});
		expect(claim.topicId).toBe(topic.topic.id);
		expect(claim.threadId).toBe(topic.thread.id);
		expect(discourse.getTopic(topic.topic.id)?.assignedAgentId).toBeUndefined();
		expect(() =>
			discourse.claimTarget({
				claimedBy: "second-agent",
				targetAddress: "#ops.release.topic.thread",
			}),
		).toThrow(/already claimed/i);

		const renewed = discourse.renewClaim({ claimId: claim.id, leaseMs: 5_000 });
		expect(renewed.expiresAt).toBeGreaterThan(claim.expiresAt);
		expect(discourse.expireClaims(renewed.expiresAt + 1)).toHaveLength(1);
		expect(discourse.listClaims(boardPathToAddress(topic.thread.address))[0]?.status).toBe("expired");

		const reclaimed = discourse.claimTarget({
			claimedBy: "release-bot",
			targetAddress: "#ops.release.topic.thread",
			leaseMs: 5_000,
		});
		const released = discourse.releaseClaim({ claimId: reclaimed.id, releasedBy: "release-bot", reason: "handoff" });
		expect(released.status).toBe("released");
	});
});

describe("DoltBackedReviewBoard — contract compliance", () => {
	it("exposes address-keyed documents across list and direct lookup entrypoints", () => {
		const { discourse, review } = createPorts();
		const { template, topic } = seedTemplateAndTopic(discourse);
		discourse.claimTarget({ claimedBy: "review-agent", targetAddress: "#ops.release.topic.thread" });
		discourse.approveTemplate({ templateId: template.id, approvedBy: "operator" });

		const summaries = review.listDocuments();
		expect(summaries).toHaveLength(1);
		expect(summaries[0]?.id).toBe(topic.thread.id);
		expect(summaries[0]?.boardId).toBe(topic.topic.boardId);
		expect(summaries[0]?.forumId).toBe(topic.topic.forumId);
		expect(summaries[0]?.targetAddress).toBe("#ops.release.topic.thread");
		expect(summaries[0]?.templateId).toBe(template.id);

		const defaultDocument = review.getDocument();
		const byId = review.getDocument(topic.thread.id);
		const byAddress = review.getDocumentByAddress("#ops.release.topic.thread");
		expect(defaultDocument?.id).toBe(topic.thread.id);
		expect(byId?.id).toBe(topic.thread.id);
		expect(byAddress?.id).toBe(topic.thread.id);
		expect(byAddress?.nodes.some((node) => node.kind === "board" && node.title === "Operations")).toBe(true);
		expect(
			byAddress?.nodes.some(
				(node) =>
					node.kind === "forum" && node.fields.some((field) => field.key === "key" && field.value === "release"),
			),
		).toBe(true);
		expect(byAddress?.nodes.some((node) => node.kind === "template")).toBe(true);
		expect(byAddress?.nodes.some((node) => node.kind === "claim")).toBe(true);
		expect(byAddress?.nodes.some((node) => node.kind === "stamp")).toBe(true);
		expect(byAddress?.nodes.some((node) => node.kind === "label" && node.title === "domain:release")).toBe(true);
		expect(byAddress?.nodes.filter((node) => node.kind === "section")).toHaveLength(2);
	});

	it("persists comments against address-keyed documents", () => {
		const { discourse, review } = createPorts();
		seedTemplateAndTopic(discourse);

		const document = review.getDocumentByAddress("#ops.release.topic.thread");
		const topicNode = document?.nodes.find((node) => node.kind === "topic");
		expect(topicNode).toBeDefined();

		review.addComment({
			documentId: document!.id,
			nodeId: topicNode!.id,
			author: "operator",
			body: "Track the blocking issues per section.",
		});

		const updated = review.getDocumentByAddress("#ops.release.topic.thread");
		expect(updated?.comments).toHaveLength(1);
		expect(updated?.comments[0]).toMatchObject({
			documentId: document!.id,
			nodeId: topicNode!.id,
			address: "#ops.release.topic.thread",
			author: "operator",
			body: "Track the blocking issues per section.",
		});
	});
});
