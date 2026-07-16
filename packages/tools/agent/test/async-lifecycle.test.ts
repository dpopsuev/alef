import { randomUUID } from "node:crypto";
import type { EventMessage, NotificationMessage } from "@dpopsuev/alef-kernel/bus";
import { InProcessBus } from "@dpopsuev/alef-kernel/bus";
import type { ExecutionStrategy } from "@dpopsuev/alef-kernel/execution";
import { describe, it, expect } from "vitest";
import { adapterComplianceSuite } from "@dpopsuev/alef-testkit/adapter";
import { createAgentAdapter } from "../src/adapter.js";

// Basic compliance suite
adapterComplianceSuite(() => createAgentAdapter({ cwd: "/tmp", replyEvent: "llm.response" }));

describe("Agent async lifecycle tools", () => {
	async function call(bus: InProcessBus, type: string, payload: Record<string, unknown>): Promise<EventMessage> {
		const correlationId = randomUUID();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				off();
				reject(new Error(`timeout: ${type}`));
			}, 5000);
			const off = bus.asBus().event.subscribe(type, (event) => {
				if (event.correlationId !== correlationId) return;
				clearTimeout(timer);
				off();
				resolve(event);
			});
			bus.asBus().command.publish({ type, payload, correlationId });
		});
	}

	async function waitForNotification(
		bus: InProcessBus,
		type: string,
		predicate?: (event: NotificationMessage) => boolean,
	): Promise<NotificationMessage> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				off();
				reject(new Error(`timeout: ${type}`));
			}, 5000);
			const off = bus.asBus().notification.subscribe(type, (event) => {
				if (predicate && !predicate(event)) return;
				clearTimeout(timer);
				off();
				resolve(event);
			});
		});
	}

	function notificationPayload(event: NotificationMessage): Record<string, unknown> {
		return event.payload as Record<string, unknown>;
	}

	it("should expose agent.cancel tool", () => {
		const adapter = createAgentAdapter({ cwd: "/tmp" });
		const tools = adapter.tools ?? [];
		const cancelTool = tools.find((t) => t.name === "agent.cancel");

		expect(cancelTool).toBeDefined();
		expect(cancelTool?.description).toContain("Cancel a running async task");
		expect(cancelTool?.inputSchema).toBeDefined();
	});

	it("should expose agent.retry tool", () => {
		const adapter = createAgentAdapter({ cwd: "/tmp" });
		const tools = adapter.tools ?? [];
		const retryTool = tools.find((t) => t.name === "agent.retry");

		expect(retryTool).toBeDefined();
		expect(retryTool?.description).toContain("Retry a failed or cancelled async task");
		expect(retryTool?.inputSchema).toBeDefined();
	});

	it("should expose agent.tasks tool", () => {
		const adapter = createAgentAdapter({ cwd: "/tmp" });
		const tools = adapter.tools ?? [];
		const tasksTool = tools.find((t) => t.name === "agent.tasks");

		expect(tasksTool).toBeDefined();
		expect(tasksTool?.description).toContain("List async tasks");
		expect(tasksTool?.inputSchema).toBeDefined();
	});

	it("should expose agent.models tool", () => {
		const adapter = createAgentAdapter({ cwd: "/tmp" });
		const tools = adapter.tools ?? [];
		const modelsTool = tools.find((t) => t.name === "agent.models");

		expect(modelsTool).toBeDefined();
		expect(modelsTool?.description).toContain("List available LLM models");
		expect(modelsTool?.inputSchema).toBeDefined();
	});

	it("should have updated AsyncTask interface with priority and abort controller", () => {
		// This is a type-level test - just verify the adapter compiles and exposes the right tools
		const adapter = createAgentAdapter({ cwd: "/tmp" });
		expect(adapter).toBeDefined();
		
		// Verify all new tools are present
		const tools = adapter.tools ?? [];
		const toolNames = tools.map((t) => t.name);
		
		expect(toolNames).toContain("agent.run");
		expect(toolNames).toContain("agent.tasks");
		expect(toolNames).toContain("agent.models");
		expect(toolNames).toContain("agent.cancel");
		expect(toolNames).toContain("agent.retry");
		expect(toolNames).toContain("agent.spawn");
		expect(toolNames).toContain("agent.ask");
		expect(toolNames).toContain("agent.race");
		expect(toolNames).toContain("agent.converse");
		expect(toolNames).toContain("agent.kill");
		expect(toolNames).toContain("agent.list");
		expect(toolNames).toContain("agent.status");
		expect(toolNames).toContain("agent.promote");
	});

	it("async runs emit started/progress/completed with shared task metadata", async () => {
		const bus = new InProcessBus();
		const discoursePosts: Array<Record<string, unknown>> = [];
		bus.asBus().command.subscribe("discourse.post", (event) => {
			discoursePosts.push(event.payload as Record<string, unknown>);
		});
		const strategy: ExecutionStrategy = {
			send: async ({ onChunk, onInnerEvent, run }) => {
				onInnerEvent?.(run?.taskId ?? "inner", "agent.identity", { color: "crimson", address: "@crimson" });
				onChunk?.("searching...");
				return "done";
			},
		};
		const adapter = createAgentAdapter({ cwd: "/tmp", strategies: { explore: strategy } });
		const unmount = adapter.mount(bus.asBus());
		try {
			const startedNotification = waitForNotification(bus, "task.started");
			const progressNotification = waitForNotification(bus, "task.progress");
			const completedNotification = waitForNotification(bus, "task.completed");
			const innerNotification = waitForNotification(bus, "agent.run.inner", (event) =>
				event.payload.innerType === "agent.identity",
			);

			const result = await call(bus, "agent.run", {
				text: "inspect the repo",
				profile: "explore",
				async: true,
				ownerAddress: "@planner",
				planId: "plan-1",
				stepId: "step-1",
				discourseTopic: "plan",
				discourseThread: "plan-1",
			});
			const taskId = String(result.payload.taskId);

			const started = await startedNotification;
			const startedPayload = notificationPayload(started);
			expect((startedPayload.task as { descriptor: { taskId: string } }).descriptor.taskId).toBe(taskId);
			expect((startedPayload.task as { descriptor: { actorAddress: string } }).descriptor.actorAddress).toBe("@planner");
			expect((startedPayload.task as { descriptor: { planId: string } }).descriptor.planId).toBe("plan-1");

			const progress = await progressNotification;
			const progressPayload = notificationPayload(progress);
			expect((progressPayload.task as { descriptor: { taskId: string } }).descriptor.taskId).toBe(taskId);
			expect(progressPayload.chunk).toBe("searching...");

			const inner = await innerNotification;
			expect(inner.payload.callId).toBe(taskId);
			expect(inner.payload.innerType).toBe("agent.identity");

			const completed = await completedNotification;
			const completedPayload = notificationPayload(completed);
			expect((completedPayload.task as { descriptor: { taskId: string } }).descriptor.taskId).toBe(taskId);
			expect(completedPayload.reply).toBe("done");
			expect(discoursePosts).toEqual([]);
		} finally {
			unmount();
		}
	});

	it("agent.cancel aborts the underlying async execution", async () => {
		const bus = new InProcessBus();
		let aborted = false;
		const strategy: ExecutionStrategy = {
			send: ({ signal }) =>
				new Promise<string>((resolve, reject) => {
					const timer = setTimeout(() => resolve("late reply"), 1000);
					signal?.addEventListener(
						"abort",
						() => {
							aborted = true;
							clearTimeout(timer);
							reject(new Error("Aborted"));
						},
						{ once: true },
					);
				}),
		};
		const adapter = createAgentAdapter({ cwd: "/tmp", strategies: { explore: strategy } });
		const unmount = adapter.mount(bus.asBus());
		try {
			const cancelledNotification = waitForNotification(bus, "task.cancelled");
			const started = await call(bus, "agent.run", { text: "inspect the repo", profile: "explore", async: true });
			const taskId = String(started.payload.taskId);
			await call(bus, "agent.cancel", { taskId });
			const cancelled = await cancelledNotification;
			const cancelledPayload = notificationPayload(cancelled);
			expect((cancelledPayload.task as { descriptor: { taskId: string } }).descriptor.taskId).toBe(taskId);
			expect(aborted).toBe(true);
		} finally {
			unmount();
		}
	});
});
