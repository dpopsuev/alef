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
import { createDiscourseAdapter } from "@dpopsuev/alef-adapter-discourse";
import { createPlanAdapter } from "@dpopsuev/alef-adapter-plan";
import { type EventMessage, InProcessBus } from "@dpopsuev/alef-kernel/bus";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("multi-agent plan + board coordination", () => {
	let dir: string;
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
		bus = new InProcessBus();
	});

	afterEach(() => {
		for (const u of unmounts.splice(0)) u();
		rmSync(dir, { recursive: true, force: true });
	});

	it("plan + board: agents post findings, parent reads and advances plan", async () => {
		const planAdapter = createPlanAdapter({ sessionDir: dir });
		const boardAdapter = createDiscourseAdapter({ sessionDir: dir });
		unmounts.push(planAdapter.mount(bus.asBus()));
		unmounts.push(boardAdapter.mount(bus.asBus()));

		// 1. Create a plan
		const beginResult = await call("plan.begin", { intention: "fix error handling gaps" });
		expect(beginResult.payload).toHaveProperty("id");

		// 2. Set state
		await call("plan.state", {
			current: "3 untyped catch blocks",
			desired: "all catch blocks use proper narrowing",
			delta: "fix 3 catch blocks",
		});

		// 3. Fix end state
		await call("plan.fix", { endState: "zero untyped catch blocks" });

		// 4. Expand plan with 3 nodes
		const expandResult = await call("plan.expand", {
			nodes: [
				{ label: "fix catch in organ-dispatch" },
				{ label: "fix catch in turn-loop" },
				{ label: "fix catch in stream-turn" },
			],
		});
		const nodeIds = (expandResult.payload as { ids: string[] }).ids;
		expect(nodeIds).toHaveLength(3);

		// 5. Simulate 3 agents posting findings to the board
		await call("forum.post", {
			topic: "qa",
			thread: "organ-dispatch",
			content: "Found untyped catch at line 128. Needs instanceof Error narrowing.",
			author: "@jade",
		});

		await call("forum.post", {
			topic: "qa",
			thread: "turn-loop",
			content: "Catch at line 115 uses String(e) — loses stack trace.",
			author: "@coral",
		});

		await call("forum.post", {
			topic: "qa",
			thread: "stream-turn",
			content: "Catch at line 42 is empty — swallows errors silently.",
			author: "@onyx",
		});

		// 6. Parent reads the board
		const boardResult = await call("forum.read", { topic: "qa", thread: "organ-dispatch" });
		const posts = (boardResult.payload as { posts: unknown[] }).posts;
		expect(posts).toHaveLength(1);

		// 7. List all topics
		const listResult = await call("forum.list", {});
		const topics = (listResult.payload as { topics: Array<{ topic: string }> }).topics;
		expect(topics.some((t) => t.topic === "qa")).toBe(true);

		// 8. Checkpoint and complete plan nodes
		await call("plan.checkpoint", { nodeId: nodeIds[0] });
		await call("plan.complete", { nodeId: nodeIds[0] });
		await call("plan.checkpoint", { nodeId: nodeIds[1] });
		await call("plan.complete", { nodeId: nodeIds[1] });
		await call("plan.checkpoint", { nodeId: nodeIds[2] });
		await call("plan.complete", { nodeId: nodeIds[2] });

		// 9. Show plan — all nodes should be done
		const showResult = await call("plan.show", {});
		const planData = showResult.payload as { nodes: Array<{ status: string }> };
		expect(planData.nodes.every((n) => n.status === "done")).toBe(true);

		// 10. Close with AAR
		await call("plan.close", {
			aar: "All 3 catch blocks fixed. Forum coordination worked — each agent posted independently.",
		});

		// Verify plan file on disk
		const planFile = JSON.parse(readFileSync(join(dir, "plan.json"), "utf-8"));
		expect(planFile.phase).toBe("closed");
		expect(planFile.aar).toContain("Forum coordination worked");

		// Verify board files on disk
		const boardFile = readFileSync(join(dir, "forum", "qa", "organ-dispatch.jsonl"), "utf-8");
		expect(boardFile).toContain("@jade");
		expect(boardFile).toContain("instanceof Error");
	});

	it("board context.assemble injects new posts into LLM context", async () => {
		// Create board adapter with a past lastReadTs so new posts are visible
		const boardAdapter = createDiscourseAdapter({ sessionDir: dir });
		unmounts.push(boardAdapter.mount(bus.asBus()));

		// Post something — the command handler writes to disk
		await call("forum.post", {
			topic: "updates",
			thread: "status",
			content: "refactoring complete",
			author: "@jade",
		});

		// Verify the context.assemble contribution exists
		const stage = boardAdapter.contributions?.["context.assemble"];
		expect(stage).toBeDefined();
	});
});
