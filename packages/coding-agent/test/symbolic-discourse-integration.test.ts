import { describe, expect, it } from "vitest";
import { boardPathToAddress } from "../src/board/types.js";
import {
	DoltBackedDiscourseStore,
	DoltBackedReviewBoard,
	InMemoryDoltStoreDriver,
} from "../src/core/platform/index.js";
import { SessionManager } from "../src/core/session-manager.js";

describe("symbolic discourse integration", () => {
	it("routes operator ingress through general, preserves affinity on relocation, and reprojects review state", () => {
		const sessionManager = SessionManager.inMemory("/tmp/project");
		const driver = new InMemoryDoltStoreDriver();
		const discourse = new DoltBackedDiscourseStore(sessionManager, driver);
		discourse.ensureBoard({
			boardId: "alef",
			title: "Alef",
			metadata: {
				repoPath: "/tmp/project",
				repoUrl: "https://example.test/alef.git",
			},
		});
		const firstLetter = discourse.postOperatorLetter({
			boardId: "alef",
			sessionId: "operator-session",
			body: "Need a release review for the patch.",
		});
		expect(firstLetter.labels.some((label) => label.key === "origin" && label.value === "operator")).toBe(true);

		const ingressSummary = discourse.listTopics().find((summary) => summary.topic.affinityKey === "operator-session");
		expect(ingressSummary).toBeDefined();
		expect(ingressSummary?.board?.metadata.repoPath).toBe("/tmp/project");
		expect(ingressSummary?.forum?.key).toBe("general");
		expect(firstLetter.forumId).toBe(ingressSummary?.forum?.id);

		const relocated = discourse.relocateTopic({
			topicId: ingressSummary!.topic.id,
			boardId: "alef",
			forumId: "release",
			relocatedBy: "gensec",
			reason: "release review",
			labels: [{ key: "domain", value: "release", source: "coordinator" }],
		});
		const relocatedAddress = boardPathToAddress(relocated.thread.address);
		expect(relocated.forum?.key).toBe("release");
		expect(relocated.topic.forumId).toBe(relocated.forum?.id);
		expect(relocated.topic.routingState).toBe("scoped");

		const secondLetter = discourse.postOperatorLetter({
			boardId: "alef",
			sessionId: "operator-session",
			body: "Blocking issue is fixed now.",
		});
		expect(secondLetter.threadId).toBe(relocated.thread.id);
		expect(secondLetter.forumId).toBe(relocated.topic.forumId);

		discourse.postLetter({
			address: relocatedAddress,
			author: "root",
			body: "Inspect open risks before merge.",
			scope: "dialog",
		});
		const topicFromAddress = discourse.getTopicByAddress(boardPathToAddress(relocated.topic.address));
		expect(topicFromAddress?.id).toBe(relocated.topic.id);

		const byAddress = discourse.readThread({ address: relocatedAddress });
		const byTopicId = discourse.readThread({ topicId: relocated.topic.id });
		const byThreadId = discourse.readThread({ threadId: relocated.thread.id });
		expect(byAddress.thread.id).toBe(byTopicId.thread.id);
		expect(byAddress.thread.id).toBe(byThreadId.thread.id);
		expect(byAddress.letters).toHaveLength(3);
		expect(byAddress.letters[0]?.forumId).toBe(relocated.topic.forumId);
		expect(discourse.getThreadByAddress(relocatedAddress)?.id).toBe(relocated.thread.id);

		const review = new DoltBackedReviewBoard(sessionManager, discourse, driver);
		const document = review.getDocumentByAddress(relocatedAddress);
		expect(document?.id).toBe(relocated.thread.id);
		expect(document?.boardId).toBe(relocated.topic.boardId);
		expect(document?.forumId).toBe(relocated.topic.forumId);
		expect(document?.templateId).toBeUndefined();
		expect(document?.nodes.some((node) => node.kind === "board" && node.title === "Alef")).toBe(true);
		expect(
			document?.nodes.some(
				(node) =>
					node.kind === "forum" && node.fields.some((field) => field.key === "key" && field.value === "release"),
			),
		).toBe(true);
		expect(document?.nodes.some((node) => node.kind === "label" && node.title === "domain:release")).toBe(true);

		const topicNode = document?.nodes.find((node) => node.kind === "topic");
		expect(topicNode).toBeDefined();
		review.addComment({
			documentId: document!.id,
			nodeId: topicNode!.id,
			author: "operator",
			body: "Add the risk checklist to this review.",
		});

		const reloadedDiscourse = new DoltBackedDiscourseStore(sessionManager, driver);
		const reloadedReview = new DoltBackedReviewBoard(sessionManager, reloadedDiscourse, driver);
		expect(reloadedDiscourse.readThread({ address: relocatedAddress }).letters).toHaveLength(3);
		expect(reloadedReview.getDocumentByAddress(relocatedAddress)?.comments[0]).toMatchObject({
			address: relocatedAddress,
			author: "operator",
			body: "Add the risk checklist to this review.",
		});
	});
});
