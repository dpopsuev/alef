import { randomUUID } from "node:crypto";
import { boardPathToAddress } from "@dpopsuev/alef-agent-runtime/board";
import type { SessionManager } from "../session-manager.js";
import { createDefaultDoltStoreDriver, type DoltStoreDriver } from "./dolt-store.js";
import type {
	AddReviewCommentRequest,
	AgentDiscoursePort,
	ReviewActionDescriptor,
	ReviewBoardPort,
	ReviewComment,
	ReviewDocument,
	ReviewDocumentSummary,
	ReviewField,
	ReviewNode,
} from "./types.js";

export const REVIEW_CUSTOM_ENTRY_TYPE = "alef.platform.review";

function cloneValue<T>(value: T): T {
	return structuredClone(value);
}

function requireNonEmpty(value: string, message: string): string {
	const normalized = value.trim();
	if (normalized.length === 0) {
		throw new Error(message);
	}
	return normalized;
}

function formatTimestamp(timestamp: number): string {
	return new Date(timestamp).toISOString();
}

function createField(key: string, value: string | undefined): ReviewField {
	return {
		key,
		value: value?.trim() || "-",
	};
}

function documentNodeId(documentId: string): string {
	return `document:${documentId}`;
}

function boardNodeId(boardId: string): string {
	return `board:${boardId}`;
}

function forumNodeId(boardId: string, forumId: string): string {
	return `forum:${boardId}:${forumId}`;
}

function templateNodeId(templateId: string): string {
	return `template:${templateId}`;
}

function templateSectionNodeId(sectionId: string): string {
	return `template-section:${sectionId}`;
}

function topicNodeId(topicId: string): string {
	return `topic:${topicId}`;
}

function threadNodeId(threadId: string): string {
	return `thread:${threadId}`;
}

function letterNodeId(letterId: string): string {
	return `letter:${letterId}`;
}

function claimNodeId(claimId: string): string {
	return `claim:${claimId}`;
}

function stampNodeId(stampId: string): string {
	return `stamp:${stampId}`;
}

function labelNodeId(parentId: string, labelId: string): string {
	return `label:${parentId}:${labelId}`;
}

function runtimeNodeId(runtimeId: string): string {
	return `runtime:${runtimeId}`;
}

function budgetNodeId(scope: string, targetId: string | undefined, window: string, bucket: string): string {
	return `budget:${scope}:${targetId ?? "global"}:${window}:${bucket}`;
}

function atomNodeId(atomId: string): string {
	return `atom:${atomId}`;
}

function moleculeNodeId(moleculeId: string): string {
	return `molecule:${moleculeId}`;
}

export class DoltBackedReviewBoard implements ReviewBoardPort {
	private readonly commentsByDocument = new Map<string, ReviewComment[]>();
	private hydrated = false;

	constructor(
		sessionManager: SessionManager,
		private readonly discourse: AgentDiscoursePort,
		private readonly driver: DoltStoreDriver = createDefaultDoltStoreDriver(sessionManager),
	) {}

	private ensureHydrated(): void {
		if (this.hydrated) {
			return;
		}
		for (const comment of this.driver.loadSnapshot().comments) {
			const comments = this.commentsByDocument.get(comment.documentId) ?? [];
			comments.push(cloneValue(comment));
			comments.sort((a, b) => a.createdAt - b.createdAt);
			this.commentsByDocument.set(comment.documentId, comments);
		}
		this.hydrated = true;
	}

	private getTemplateActions(status: string | undefined): ReviewActionDescriptor[] {
		return [
			{
				id: "approveTemplate",
				label: "Approve template",
				description: "Stamp this template for live topic work.",
				enabled: status === "draft",
			},
			{
				id: "rejectTemplate",
				label: "Reject template",
				description: "Reject this template or contract with review input.",
				enabled: status !== "completed" && status !== "cancelled",
			},
			{
				id: "requestStamp",
				label: "Request stamp",
				description: "Ask a reviewer or HITL to stamp this template.",
				enabled: status !== "completed" && status !== "cancelled",
			},
			{
				id: "createTopic",
				label: "Create topic",
				description: "Open a live topic that satisfies this template.",
				enabled: status !== "completed" && status !== "cancelled",
			},
		];
	}

	private getTopicActions(isAssigned: boolean, status: string): ReviewActionDescriptor[] {
		return [
			{
				id: "assignTopic",
				label: "Assign topic",
				description: "Spawn or attach an agent to this topic.",
				enabled: !isAssigned && status !== "resolved" && status !== "cancelled",
			},
			{
				id: "relocateTopic",
				label: "Relocate topic",
				description: "Move this topic into a better forum while keeping the thread live.",
				enabled: status !== "resolved" && status !== "cancelled",
			},
			{
				id: "claimTopic",
				label: "Claim topic",
				description: "Acquire a lease without changing assignment state.",
				enabled: status !== "resolved" && status !== "cancelled",
			},
			{
				id: "readThread",
				label: "Read thread",
				description: "Drill down into the topic thread and letters.",
				enabled: true,
			},
		];
	}

	private appendLabelNodes(
		nodes: ReviewNode[],
		parentId: string,
		labels: ReadonlyArray<{ id: string; key: string; value?: string }>,
	): void {
		for (const label of labels) {
			nodes.push({
				id: labelNodeId(parentId, label.id),
				parentId,
				kind: "label",
				title: label.value ? `${label.key}:${label.value}` : label.key,
				summary: "Discourse label",
				body: label.value ? `${label.key}:${label.value}` : label.key,
				fields: [createField("key", label.key), createField("value", label.value)],
				actions: [],
			});
		}
	}

	private buildDocument(threadId: string): ReviewDocument | undefined {
		this.ensureHydrated();
		const threadView = this.discourse.readThread({ threadId });
		const address = boardPathToAddress(threadView.thread.address);
		const comments = (this.commentsByDocument.get(threadId) ?? []).map((comment) => cloneValue(comment));
		const nodes: ReviewNode[] = [];
		const latestLetter = threadView.letters[threadView.letters.length - 1];

		nodes.push({
			id: documentNodeId(threadId),
			kind: "document",
			title: threadView.topic.title,
			summary: threadView.topic.summary ?? latestLetter?.body ?? `Review target ${address}`,
			body: `Address: ${address}\nThread: ${threadId}`,
			status: threadView.topic.lifecycle,
			fields: [
				createField("documentId", threadId),
				createField("address", address),
				createField("boardId", threadView.topic.boardId),
				createField("forumId", threadView.topic.forumId),
				createField("topicKey", threadView.topic.key),
				createField("topicId", threadView.topic.id),
				createField("topicLifecycle", threadView.topic.lifecycle),
				createField("threadKey", threadView.thread.key),
				createField("threadId", threadView.thread.id),
				createField("threadLifecycle", threadView.thread.lifecycle),
				createField("templateId", threadView.topic.templateId ?? threadView.topic.satisfiesTemplateId),
			],
			actions: this.getTopicActions(Boolean(threadView.topic.assignedAgentId), threadView.topic.status),
		});

		if (threadView.board) {
			nodes.push({
				id: boardNodeId(threadView.board.id),
				parentId: documentNodeId(threadId),
				kind: "board",
				title: threadView.board.title,
				summary: threadView.board.description ?? `Board ${threadView.board.key}`,
				body: JSON.stringify(threadView.board.metadata, null, 2),
				fields: [
					createField("id", threadView.board.id),
					createField("key", threadView.board.key),
					createField("defaultForumId", threadView.board.defaultForumId),
					createField("defaultForumKey", threadView.board.defaultForumKey),
					createField("updatedAt", formatTimestamp(threadView.board.updatedAt)),
				],
				actions: [],
			});
			this.appendLabelNodes(nodes, boardNodeId(threadView.board.id), threadView.board.labels);
		}

		if (threadView.forum) {
			nodes.push({
				id: forumNodeId(threadView.forum.boardId, threadView.forum.id),
				parentId: threadView.board ? boardNodeId(threadView.board.id) : documentNodeId(threadId),
				kind: "forum",
				title: threadView.forum.title,
				summary: threadView.forum.description ?? `Forum ${threadView.forum.key}`,
				body: threadView.forum.description,
				fields: [
					createField("id", threadView.forum.id),
					createField("key", threadView.forum.key),
					createField("boardId", threadView.forum.boardId),
					createField("updatedAt", formatTimestamp(threadView.forum.updatedAt)),
				],
				actions: [],
			});
			this.appendLabelNodes(
				nodes,
				forumNodeId(threadView.forum.boardId, threadView.forum.id),
				threadView.forum.labels,
			);
		}

		nodes.push({
			id: topicNodeId(threadView.topic.id),
			parentId: threadView.forum
				? forumNodeId(threadView.forum.boardId, threadView.forum.id)
				: threadView.board
					? boardNodeId(threadView.board.id)
					: documentNodeId(threadId),
			kind: "topic",
			title: threadView.topic.title,
			summary: threadView.topic.summary ?? latestLetter?.body ?? "No summary yet.",
			body: latestLetter?.body,
			status: threadView.topic.lifecycle,
			fields: [
				createField("address", boardPathToAddress(threadView.topic.address)),
				createField("boardId", threadView.topic.boardId),
				createField("forumId", threadView.topic.forumId),
				createField("key", threadView.topic.key),
				createField("status", threadView.topic.status),
				createField("lifecycle", threadView.topic.lifecycle),
				createField("routing", threadView.topic.routingState),
				createField("assignedAgentId", threadView.topic.assignedAgentId),
				createField("assignedBlueprint", threadView.topic.assignedBlueprint),
				createField("updatedAt", formatTimestamp(threadView.topic.updatedAt)),
			],
			actions: this.getTopicActions(Boolean(threadView.topic.assignedAgentId), threadView.topic.status),
		});
		this.appendLabelNodes(nodes, topicNodeId(threadView.topic.id), threadView.topic.labels);

		if (threadView.template) {
			nodes.push({
				id: templateNodeId(threadView.template.id),
				parentId: documentNodeId(threadId),
				kind: "template",
				title: threadView.template.title,
				summary: `Template status: ${threadView.template.status}`,
				body: threadView.template.anchor,
				status: threadView.template.status,
				fields: [
					createField("id", threadView.template.id),
					createField("key", threadView.template.key),
					createField("anchor", threadView.template.anchor),
					createField("boardId", threadView.template.boardId),
					createField("forumId", threadView.template.forumId),
					createField("approvedBy", threadView.template.approvedBy),
					createField("updatedAt", formatTimestamp(threadView.template.updatedAt)),
				],
				actions: this.getTemplateActions(threadView.template.status),
			});
			this.appendLabelNodes(nodes, templateNodeId(threadView.template.id), threadView.template.labels);

			for (const section of [...threadView.template.sections].sort((a, b) => a.order - b.order)) {
				nodes.push({
					id: templateSectionNodeId(section.id),
					parentId: templateNodeId(threadView.template.id),
					kind: "section",
					title: section.title,
					summary: section.status ?? "Template section",
					body: section.body,
					status: section.status,
					fields: [createField("order", String(section.order))],
					actions: [],
				});
			}

			for (const stamp of threadView.stamps) {
				nodes.push({
					id: stampNodeId(stamp.id),
					parentId: templateNodeId(threadView.template.id),
					kind: "stamp",
					title: `${stamp.decision} · ${stamp.decidedBy ?? stamp.requestedBy}`,
					summary: stamp.rationale ?? `Requested by ${stamp.requestedBy}`,
					body: stamp.input,
					status: stamp.decision,
					fields: [
						createField("requestedBy", stamp.requestedBy),
						createField("requestedAt", formatTimestamp(stamp.requestedAt)),
						createField("decidedBy", stamp.decidedBy),
						createField("decidedAt", stamp.decidedAt ? formatTimestamp(stamp.decidedAt) : undefined),
					],
					actions: [],
				});
			}
		}

		nodes.push({
			id: threadNodeId(threadView.thread.id),
			parentId: topicNodeId(threadView.topic.id),
			kind: "thread",
			title: threadView.thread.title,
			summary: `${threadView.letters.length} letter${threadView.letters.length === 1 ? "" : "s"}`,
			body:
				threadView.letters.length > 0
					? threadView.letters.map((letter) => `${letter.author}: ${letter.body}`).join("\n\n")
					: "No letters yet.",
			status: threadView.thread.status,
			fields: [
				createField("documentId", threadId),
				createField("address", address),
				createField("boardId", threadView.thread.boardId),
				createField("forumId", threadView.thread.forumId),
				createField("key", threadView.thread.key),
				createField("status", threadView.thread.status),
				createField("lifecycle", threadView.thread.lifecycle),
				createField("letters", String(threadView.letters.length)),
				createField("claims", String(threadView.claims.length)),
				createField("runtimes", String(threadView.runtimes.length)),
				createField("budgets", String(threadView.budget.length)),
				createField("atoms", String(threadView.atoms.length)),
				createField("molecules", String(threadView.molecules.length)),
				createField("updatedAt", formatTimestamp(threadView.thread.updatedAt)),
			],
			actions: [
				{
					id: "readThread",
					label: "Read thread",
					description: "Inspect full letter history for this topic.",
					enabled: true,
				},
			],
		});
		this.appendLabelNodes(nodes, threadNodeId(threadView.thread.id), threadView.thread.labels);

		for (const claim of threadView.claims) {
			nodes.push({
				id: claimNodeId(claim.id),
				parentId: threadNodeId(threadView.thread.id),
				kind: "claim",
				title: `${claim.claimedBy} · ${claim.status}`,
				summary: claim.reason ?? claim.targetAddress,
				body: claim.labelSelectors.join("\n"),
				status: claim.status,
				fields: [
					createField("claimedBy", claim.claimedBy),
					createField("expiresAt", formatTimestamp(claim.expiresAt)),
					createField("targetAddress", claim.targetAddress),
				],
				actions: [],
			});
		}

		for (const letter of threadView.letters) {
			nodes.push({
				id: letterNodeId(letter.id),
				parentId: threadNodeId(threadView.thread.id),
				kind: "letter",
				title: `${letter.author} · ${letter.scope}`,
				summary: letter.body,
				body: letter.body,
				status: letter.scope,
				fields: [
					createField("scope", letter.scope),
					createField("author", letter.author),
					createField("forumId", letter.forumId),
					createField("routing", letter.routingState),
					createField("createdAt", formatTimestamp(letter.createdAt)),
				],
				actions: [],
			});
			this.appendLabelNodes(nodes, letterNodeId(letter.id), letter.labels);
		}

		for (const runtime of threadView.runtimes) {
			nodes.push({
				id: runtimeNodeId(runtime.id),
				parentId: threadNodeId(threadView.thread.id),
				kind: "runtime",
				title: runtime.name,
				summary: runtime.latestSummary ?? runtime.status,
				body: runtime.lastError,
				status: runtime.status,
				fields: [
					createField("id", runtime.id),
					createField("status", runtime.status),
					createField("topicId", runtime.topicId),
					createField("threadId", runtime.threadId),
					createField("claimId", runtime.claimId),
					createField("sessionId", runtime.sessionId),
					createField("sessionFile", runtime.sessionFile),
					createField("updatedAt", formatTimestamp(runtime.updatedAt)),
				],
				actions: [],
			});
		}

		for (const budget of threadView.budget) {
			nodes.push({
				id: budgetNodeId(budget.scope, budget.targetId, budget.window, budget.bucket),
				parentId: threadNodeId(threadView.thread.id),
				kind: "budget",
				title: `${budget.scope}:${budget.targetId ?? "global"} ${budget.window}`,
				summary: `${budget.usedTokens}/${budget.maxTokens} tokens`,
				body: budget.action,
				status: budget.action,
				fields: [
					createField("bucket", budget.bucket),
					createField("usedTokens", String(budget.usedTokens)),
					createField("maxTokens", String(budget.maxTokens)),
					createField("remainingTokens", String(budget.remainingTokens)),
					createField("action", budget.action),
				],
				actions: [],
			});
		}

		for (const atom of threadView.atoms) {
			nodes.push({
				id: atomNodeId(atom.id),
				parentId: threadNodeId(threadView.thread.id),
				kind: "atom",
				title: atom.title,
				summary: atom.summary ?? atom.kind,
				body: atom.body,
				status: atom.scope,
				fields: [
					createField("kind", atom.kind),
					createField("scope", atom.scope),
					createField("sourceType", atom.sourceType),
					createField("sourceId", atom.sourceId),
					createField("runtimeId", atom.runtimeId),
				],
				actions: [],
			});
		}

		for (const molecule of threadView.molecules) {
			nodes.push({
				id: moleculeNodeId(molecule.id),
				parentId: threadNodeId(threadView.thread.id),
				kind: "molecule",
				title: molecule.title,
				summary: molecule.summary ?? molecule.kind,
				body: molecule.body,
				status: molecule.sealed ? "sealed" : "open",
				fields: [
					createField("kind", molecule.kind),
					createField("atoms", String(molecule.atomIds.length)),
					createField("runtimeId", molecule.runtimeId),
				],
				actions: [],
			});
		}

		const latestCommentAt = comments.reduce(
			(latest, comment) => Math.max(latest, comment.createdAt),
			Math.max(threadView.topic.updatedAt, threadView.thread.updatedAt, threadView.template?.updatedAt ?? 0),
		);

		return {
			id: threadView.thread.id,
			title: threadView.topic.title,
			description: `Discourse review · ${address}`,
			updatedAt: latestCommentAt,
			boardId: threadView.topic.boardId,
			forumId: threadView.topic.forumId,
			targetAddress: address,
			templateId: threadView.template?.id,
			nodes,
			comments,
		};
	}

	listDocuments(): ReviewDocumentSummary[] {
		this.ensureHydrated();
		return this.discourse
			.listTopics()
			.map((summary) => this.buildDocument(summary.thread.id))
			.filter((document): document is ReviewDocument => document !== undefined)
			.sort((a, b) => b.updatedAt - a.updatedAt)
			.map((document) => ({
				id: document.id,
				title: document.title,
				description: document.description,
				updatedAt: document.updatedAt,
				boardId: document.boardId,
				forumId: document.forumId,
				targetAddress: document.targetAddress,
				templateId: document.templateId,
			}));
	}

	getDocument(documentId?: string): ReviewDocument | undefined {
		this.ensureHydrated();
		const documents = this.listDocuments();
		if (documents.length === 0) {
			return undefined;
		}
		const targetId = documentId ?? documents[0]?.id;
		if (!targetId) {
			return undefined;
		}
		if (targetId.startsWith("#")) {
			return this.getDocumentByAddress(targetId);
		}
		return this.buildDocument(targetId);
	}

	getDocumentByAddress(address: string): ReviewDocument | undefined {
		this.ensureHydrated();
		try {
			const thread = this.discourse.getThreadByAddress(address);
			return thread ? this.buildDocument(thread.id) : undefined;
		} catch {
			return undefined;
		}
	}

	addComment(request: AddReviewCommentRequest): ReviewComment {
		this.ensureHydrated();
		const document = this.getDocument(request.documentId);
		if (!document) {
			throw new Error(`Unknown review document: ${request.documentId}`);
		}
		const targetNode = document.nodes.find((node) => node.id === request.nodeId);
		if (!targetNode) {
			throw new Error(`Unknown review node: ${request.nodeId}`);
		}
		const comment: ReviewComment = {
			id: randomUUID(),
			documentId: document.id,
			nodeId: request.nodeId,
			author: requireNonEmpty(request.author, "Review comment author cannot be empty."),
			body: requireNonEmpty(request.body, "Review comment body cannot be empty."),
			address: request.address ?? document.targetAddress,
			createdAt: Date.now(),
		};
		const comments = this.commentsByDocument.get(comment.documentId) ?? [];
		comments.push(cloneValue(comment));
		comments.sort((a, b) => a.createdAt - b.createdAt);
		this.commentsByDocument.set(comment.documentId, comments);
		this.driver.insertComment(comment);
		return cloneValue(comment);
	}
}

export const SessionBackedReviewBoard = DoltBackedReviewBoard;
