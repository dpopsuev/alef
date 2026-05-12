import { describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import {
	compileAgentDefinition,
	SessionBackedDiscourseStore,
	SessionBackedReviewBoard,
	SupervisorManager,
} from "../src/core/platform/index.js";
import { SessionManager } from "../src/core/session-manager.js";

interface FakeSessionEvent {
	type: string;
	message?: unknown;
	messages?: unknown[];
}

class FakeChildSession {
	cwd = "/tmp/project";
	sessionId = "child-session";
	sessionFile = undefined;
	isStreaming = false;
	state = {
		messages: [] as unknown[],
		errorMessage: undefined as string | undefined,
	};

	private listeners: Array<(event: FakeSessionEvent) => void> = [];

	get messages() {
		return this.state.messages;
	}

	subscribe(listener: (event: FakeSessionEvent) => void): () => void {
		this.listeners.push(listener);
		return () => {
			this.listeners = this.listeners.filter((entry) => entry !== listener);
		};
	}

	private emit(event: FakeSessionEvent): void {
		for (const listener of this.listeners) {
			listener(event);
		}
	}

	async prompt(message: string): Promise<void> {
		const now = Date.now();
		const userMessage = {
			role: "user" as const,
			content: message,
			timestamp: now,
		};
		const assistantMessage = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: `done:${message}` }],
			timestamp: now + 1,
			stopReason: "end_turn",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0 },
			},
		};
		this.state.messages.push(userMessage, assistantMessage);
		this.emit({ type: "agent_start" });
		this.emit({ type: "message_end", message: userMessage });
		this.emit({ type: "message_end", message: assistantMessage });
		this.emit({ type: "agent_end", messages: [...this.state.messages] });
	}

	async abort(): Promise<void> {}

	dispose(): void {}
}

describe("platform organs", () => {
	it("compiles organs into tool allowlists", () => {
		const definition = compileAgentDefinition({
			name: "reviewer",
			organs: [
				{ name: "fs", actions: ["outline", "read", "grep", "ls"] },
				{ name: "shell", actions: ["exec"] },
			],
		});

		expect(definition.organs).toEqual([
			{
				name: "fs",
				actions: ["outline", "read", "grep", "ls"],
				toolNames: ["symbol_outline", "file_read", "file_grep", "file_ls"],
			},
			{
				name: "shell",
				actions: ["exec"],
				toolNames: ["file_bash"],
			},
		]);
		expect(definition.capabilities.tools).toEqual([
			"symbol_outline",
			"file_read",
			"file_grep",
			"file_ls",
			"file_bash",
		]);
		expect(definition.capabilities.supervisor).toBe(false);
	});

	it("persists discourse and mirrors child summaries through supervisor", async () => {
		const sessionManager = SessionManager.inMemory("/tmp/project");
		sessionManager.appendMessage({
			role: "user",
			content: "root message",
			timestamp: Date.now(),
		});
		const leafBefore = sessionManager.getLeafId();
		const discourse = new SessionBackedDiscourseStore(sessionManager);

		const contract = discourse.createContract({ anchor: "Ship the change set." });
		expect(sessionManager.getLeafId()).toBe(leafBefore);

		const topic = discourse.createTopic({ contractId: contract.id, title: "Review the patch" });
		const fakeSession = new FakeChildSession();
		const manager = new SupervisorManager(async () => fakeSession as unknown as AgentSession, discourse);
		const definition = compileAgentDefinition({
			name: "reviewer",
			organs: [{ name: "fs", actions: ["read"] }],
		});

		const child = await manager.spawnAgent({
			definition,
			initialMessage: "Inspect the diff",
			templateId: contract.id,
			contractId: contract.id,
			topicId: topic.topic.id,
			threadId: topic.thread.id,
		});

		expect(child.topicId).toBe(topic.topic.id);
		expect(child.templateId).toBe(contract.id);
		expect(child.discourseAddress).toBeDefined();
		expect(child.latestSummary).toBe("done:Inspect the diff");

		const thread = discourse.readThread({ topicId: topic.topic.id });
		expect(thread.letters.map((letter) => letter.body)).toEqual(["Inspect the diff", "done:Inspect the diff"]);

		const reloaded = new SessionBackedDiscourseStore(sessionManager);
		const summary = reloaded.listTopics(contract.id)[0];
		expect(summary.topic.assignedAgentId).toBe(child.id);
		expect(summary.topic.summary).toBe("done:Inspect the diff");
		expect(summary.latestLetter?.body).toBe("done:Inspect the diff");
	});

	it("projects discourse into review documents and persists operator comments", () => {
		const sessionManager = SessionManager.inMemory("/tmp/project");
		sessionManager.appendMessage({
			role: "user",
			content: "root message",
			timestamp: Date.now(),
		});
		const leafBefore = sessionManager.getLeafId();
		const discourse = new SessionBackedDiscourseStore(sessionManager);
		const contract = discourse.createContract({ anchor: "Ship the change set." });
		const topic = discourse.createTopic({ contractId: contract.id, title: "Review the patch" });
		discourse.postLetter({
			threadId: topic.thread.id,
			author: "root",
			body: "Inspect the diff and call out open risks.",
			scope: "dialog",
		});

		const review = new SessionBackedReviewBoard(sessionManager, discourse);
		const documents = review.listDocuments();
		expect(documents).toHaveLength(1);

		const document = review.getDocument(documents[0].id);
		expect(document?.title).toBe("Review the patch");
		expect(document?.id).toBe(documents[0]?.id);
		expect(document?.targetAddress).toBe(documents[0]?.targetAddress);
		expect(document?.nodes.some((node) => node.kind === "template" && node.title === "Ship the change set.")).toBe(
			true,
		);
		expect(document?.nodes.some((node) => node.kind === "topic" && node.title === "Review the patch")).toBe(true);

		const topicNode = document?.nodes.find((node) => node.kind === "topic" && node.title === "Review the patch");
		expect(topicNode).toBeDefined();

		review.addComment({
			documentId: document!.id,
			nodeId: topicNode!.id,
			author: "operator",
			body: "Add acceptance criteria before assigning this topic.",
		});
		expect(sessionManager.getLeafId()).toBe(leafBefore);

		const reloaded = new SessionBackedReviewBoard(sessionManager, discourse);
		const reloadedDocument = reloaded.getDocument(document!.id);
		expect(reloadedDocument?.comments).toHaveLength(1);
		expect(reloadedDocument?.comments[0]).toMatchObject({
			nodeId: topicNode!.id,
			author: "operator",
			body: "Add acceptance criteria before assigning this topic.",
		});
	});
});
