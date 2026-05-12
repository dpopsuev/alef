import { describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import {
	compileAgentDefinition,
	DoltBackedDiscourseStore,
	InMemoryDoltStoreDriver,
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
	sessionId = `child-session-${Math.random().toString(36).slice(2)}`;
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

const definition = compileAgentDefinition({
	name: "release-worker",
	organs: [{ name: "fs", actions: ["read"] }],
});

describe("SupervisorManager lifecycle", () => {
	it("drains runtimes into knowledge atoms and molecules", async () => {
		const sessionManager = SessionManager.inMemory("/tmp/project");
		const discourse = new DoltBackedDiscourseStore(sessionManager, new InMemoryDoltStoreDriver());
		discourse.ensureBoard({ boardId: "ops", title: "Operations" });
		const topic = discourse.createTopic({
			boardId: "ops",
			forumId: "release",
			title: "Drain runtime",
			address: "#ops.release.drain-runtime.thread",
		});

		const fakeSession = new FakeChildSession();
		const manager = new SupervisorManager(async () => fakeSession as unknown as AgentSession, discourse);
		const child = await manager.spawnAgent({
			definition,
			name: "release-worker",
			initialMessage: "Inspect the patch",
			topicId: topic.topic.id,
			threadId: topic.thread.id,
			discourseObjectId: topic.topic.id,
		});

		expect(discourse.getRuntime(child.id)?.status).toBe("idle");
		await manager.signalAgent({ agentId: child.id, signal: "sleep" });
		expect(discourse.getRuntime(child.id)?.status).toBe("sleep");
		await manager.signalAgent({ agentId: child.id, signal: "drain" });

		expect(discourse.getRuntime(child.id)?.status).toBe("archived");
		const atoms = discourse.listKnowledgeAtoms({ runtimeId: child.id });
		const molecules = discourse.listKnowledgeMolecules({ runtimeId: child.id });
		expect(atoms.map((atom) => atom.body)).toEqual(["Inspect the patch", "done:Inspect the patch"]);
		expect(molecules).toHaveLength(1);
		expect(molecules[0]?.atomIds).toHaveLength(atoms.length);

		const threadView = discourse.readThread({ threadId: topic.thread.id });
		expect(threadView.topic.lifecycle).toBe("archived");
		expect(threadView.atoms).toHaveLength(2);
		expect(threadView.molecules).toHaveLength(1);
	});

	it("blocks new spawns when capacity is full", async () => {
		const sessionManager = SessionManager.inMemory("/tmp/project");
		const discourse = new DoltBackedDiscourseStore(sessionManager, new InMemoryDoltStoreDriver());
		discourse.ensureBoard({ boardId: "ops", title: "Operations" });
		discourse.setAgentCapacity({ maxConcurrent: 1 });
		const topicA = discourse.createTopic({
			boardId: "ops",
			forumId: "release",
			title: "Capacity A",
			address: "#ops.release.capacity-a.thread",
		});
		const topicB = discourse.createTopic({
			boardId: "ops",
			forumId: "release",
			title: "Capacity B",
			address: "#ops.release.capacity-b.thread",
		});

		const manager = new SupervisorManager(async () => new FakeChildSession() as unknown as AgentSession, discourse);

		await manager.spawnAgent({
			definition,
			name: "release-worker",
			topicId: topicA.topic.id,
			threadId: topicA.thread.id,
			discourseObjectId: topicA.topic.id,
		});

		await expect(
			manager.spawnAgent({
				definition: compileAgentDefinition({
					name: "release-worker-b",
					organs: [{ name: "fs", actions: ["read"] }],
				}),
				name: "release-worker-b",
				topicId: topicB.topic.id,
				threadId: topicB.thread.id,
				discourseObjectId: topicB.topic.id,
			}),
		).rejects.toThrow("Agent capacity exceeded");
	});

	it("blocks new spawns when the discourse-object budget is throttled", async () => {
		const sessionManager = SessionManager.inMemory("/tmp/project");
		const discourse = new DoltBackedDiscourseStore(sessionManager, new InMemoryDoltStoreDriver());
		discourse.ensureBoard({ boardId: "ops", title: "Operations" });
		const topic = discourse.createTopic({
			boardId: "ops",
			forumId: "release",
			title: "Budget gate",
			address: "#ops.release.budget-gate.thread",
		});
		discourse.upsertBudgetPolicy({
			scope: "discourse_object",
			targetId: topic.topic.id,
			createdBy: "operator",
			day: { maxTokens: 30, throttleAt: 20 },
		});
		discourse.recordBudgetUsage({
			discourseObjectId: topic.topic.id,
			inputTokens: 12,
			outputTokens: 10,
		});

		const manager = new SupervisorManager(async () => new FakeChildSession() as unknown as AgentSession, discourse);
		await expect(
			manager.spawnAgent({
				definition,
				name: "release-worker",
				topicId: topic.topic.id,
				threadId: topic.thread.id,
				discourseObjectId: topic.topic.id,
			}),
		).rejects.toThrow("Budget throttle prevents spawning");
	});
});
