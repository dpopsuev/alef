/**
 * Multi-agent coordination test: plan + board + parallel agents.
 *
 * Demonstrates: one plan, multiple agents posting findings to the board,
 * parent reading the board and advancing the plan.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type EventMessage, InProcessBus } from "@dpopsuev/alef-kernel/bus";
import { createDiscourseAdapter } from "@dpopsuev/alef-tool-discourse";
import { createPlanAdapter, PlanStore } from "@dpopsuev/alef-tool-plan";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("multi-agent plan + board coordination", () => {
	let dir: string;
	let plansRoot: string;
	let bus: InProcessBus;
	const unmounts: Array<() => void> = [];

	function call(type: string, payload: Record<string, unknown>): Promise<EventMessage> {
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

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "alef-multi-agent-test-"));
		plansRoot = join(dir, ".plans");
		bus = new InProcessBus();
	});

	afterEach(() => {
		for (const u of unmounts.splice(0)) u();
		rmSync(dir, { recursive: true, force: true });
	});

	it("plan + board: agents post findings, parent reads and advances plan", async () => {
		const planAdapter = createPlanAdapter({ cwd: dir, plansRoot });
		const boardAdapter = createDiscourseAdapter({ sessionDir: dir });
		unmounts.push(planAdapter.mount(bus.asBus()));
		unmounts.push(boardAdapter.mount(bus.asBus()));

		const openResult = await call("plan.open", {
			current: "3 untyped catch blocks",
			desired: "all catch blocks use proper narrowing",
			verify: "zero untyped catch blocks remain",
		});
		expect(openResult.payload).toHaveProperty("id");

		const stepsResult = await call("plan.steps", {
			steps: [
				{ label: "fix catch in tool-dispatch" },
				{ label: "fix catch in turn-loop path" },
				{ label: "fix catch in stream-turn path" },
			],
		});
		const stepIds = (stepsResult.payload as { ids?: string[] }).ids;
		expect(stepIds).toHaveLength(3);

		await call("discourse.post", {
			topic: "qa",
			thread: "tool-dispatch",
			content: "Found untyped catch at line 128. Needs instanceof Error narrowing.",
			author: "@jade",
		});

		await call("discourse.post", {
			topic: "qa",
			thread: "turn-loop",
			content: "Catch at line 115 uses String(e) — loses stack trace.",
			author: "@coral",
		});

		await call("discourse.post", {
			topic: "qa",
			thread: "stream-turn",
			content: "Catch at line 42 is empty — swallows errors silently.",
			author: "@onyx",
		});

		const boardResult = await call("discourse.read", { topic: "qa", thread: "tool-dispatch" });
		const posts = (boardResult.payload as { posts: unknown[] }).posts;
		expect(posts).toHaveLength(1);

		const listResult = await call("discourse.list", {});
		const topics = (listResult.payload as { topics: Array<{ topic: string }> }).topics;
		expect(topics.some((t) => t.topic === "qa")).toBe(true);

		for (const stepId of stepIds!) {
			await call("plan.advance", { stepId, action: "start" });
			await call("plan.advance", { stepId, action: "done", result: "narrowed catch" });
		}

		const showResult = await call("plan.show", {});
		const planData = showResult.payload as { steps: Array<{ status: string }> };
		expect(planData.steps.every((step) => step.status === "done")).toBe(true);

		await call("plan.close", {
			summary: "All 3 catch blocks fixed. Forum coordination worked — each agent posted independently.",
		});

		const store = new PlanStore({ cwd: dir, plansRoot });
		const closed = store.list({ status: "closed" });
		expect(closed).toHaveLength(1);
		const closedPlan = store.load(closed[0]!.id);
		expect(closedPlan?.phase).toBe("closed");
		expect(closedPlan?.toJSON().summary).toContain("Forum coordination worked");

		const boardFile = readFileSync(join(dir, "discourse", "qa", "tool-dispatch.jsonl"), "utf-8");
		expect(boardFile).toContain("@jade");
		expect(boardFile).toContain("instanceof Error");
	});

	it("board context.assemble injects new posts into LLM context", async () => {
		const boardAdapter = createDiscourseAdapter({ sessionDir: dir });
		unmounts.push(boardAdapter.mount(bus.asBus()));

		await call("discourse.post", {
			topic: "updates",
			thread: "status",
			content: "refactoring complete",
			author: "@jade",
		});

		const stage = boardAdapter.contributions?.["context.assemble"];
		expect(stage).toBeDefined();
	});
});
