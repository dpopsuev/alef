import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adapterComplianceSuite } from "@dpopsuev/alef-testkit/organ";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPlanAdapter } from "../src/adapter.js";
import { PlanGraph } from "../src/graph.js";

adapterComplianceSuite(() => createPlanAdapter({ sessionDir: mkdtempSync(join(tmpdir(), "alef-plan-compliance-")) }));

describe("PlanGraph", { tags: ["unit"] }, () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "alef-plan-test-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("creates with intention phase", () => {
		const g = new PlanGraph("p1", "fix auth module", join(dir, "plan.json"));
		expect(g.phase).toBe("intention");
		expect(g.block).toBe("ideation");
	});

	it("transitions through ideation block", () => {
		const g = new PlanGraph("p1", "fix auth", join(dir, "plan.json"));
		g.setInception("broken login", "working login", "fix the auth handler");
		expect(g.phase).toBe("inception");
		g.addExclusion("don't change the database");
		expect(g.phase).toBe("contraction");
		g.setEndState("login works, tests pass");
		expect(g.phase).toBe("fixation");
	});

	it("builds and prunes a tree", () => {
		const g = new PlanGraph("p1", "refactor", join(dir, "plan.json"));
		g.setInception("messy", "clean", "extract helpers");
		g.setEndState("clean code");
		const n0 = g.addNode("read the source code");
		g.addNode("extract helper function A", n0.id);
		const n2 = g.addNode("extract helper function B", n0.id);
		expect(g.children(n0.id)).toHaveLength(2);
		g.pruneNode(n2.id);
		expect(g.stats().pruned).toBe(1);
	});

	it("persists and reloads from disk", () => {
		const path = join(dir, "plan.json");
		const g = new PlanGraph("p1", "test persist", path);
		g.setInception("before", "after", "change it");
		g.addNode("implement the first step");
		const loaded = PlanGraph.load(path);
		expect(loaded).not.toBeNull();
		expect(loaded!.phase).toBe("expansion");
		expect(loaded!.stats().total).toBe(1);
	});

	it("renders a tree", () => {
		const g = new PlanGraph("p1", "render test", join(dir, "plan.json"));
		g.setInception("a", "b", "c");
		g.setEndState("done");
		const root = g.addNode("complete the root task");
		g.addNode("finish the first subtask", root.id);
		g.addNode("finish the second subtask", root.id);
		const tree = g.renderTree();
		expect(tree).toContain("complete the root task");
		expect(tree).toContain("finish the first subtask");
		expect(tree).toContain("finish the second subtask");
	});

	it("enforces forward-only phase transitions", () => {
		const g = new PlanGraph("p1", "test", join(dir, "plan.json"));
		g.setInception("a", "b", "c");
		const err = g.advanceTo("intention");
		expect(err).toContain("cannot go back");
	});

	it("generates slugified node IDs from labels", () => {
		const g = new PlanGraph("p1", "slug test", join(dir, "plan.json"));
		g.setInception("a", "b", "c");
		g.setEndState("done");
		const node = g.addNode("extract authentication middleware logic");
		expect(node.id).toBe("extract-authentication-middleware-logic");
	});

	it("disambiguates duplicate slugs with sequence suffix", () => {
		const g = new PlanGraph("p1", "dup test", join(dir, "plan.json"));
		g.setInception("a", "b", "c");
		g.setEndState("done");
		const a = g.addNode("refactor the auth module");
		const b = g.addNode("refactor the auth module");
		expect(a.id).toBe("refactor-the-auth-module");
		expect(b.id).not.toBe(a.id);
		expect(b.id).toMatch(/^refactor-the-auth-module-\d+$/);
	});

	it("rejects labels shorter than 3 words", () => {
		const g = new PlanGraph("p1", "test", join(dir, "plan.json"));
		g.setInception("a", "b", "c");
		g.setEndState("done");
		expect(() => g.addNode("too short")).toThrow(/too short/);
	});

	it("rejects labels longer than 8 words", () => {
		const g = new PlanGraph("p1", "test", join(dir, "plan.json"));
		g.setInception("a", "b", "c");
		g.setEndState("done");
		expect(() => g.addNode("one two three four five six seven eight nine")).toThrow(/too long/);
	});

	it("extractSubgraph returns subtree rooted at node", () => {
		const g = new PlanGraph("p1", "extract test", join(dir, "plan.json"));
		g.setInception("a", "b", "c");
		g.setEndState("done");
		const root = g.addNode("explore the root directory");
		const child1 = g.addNode("scan the first child", root.id);
		g.addNode("inspect the nested grandchild", child1.id);
		g.addNode("scan the second child", root.id);
		g.addNode("handle the sibling separately");

		const subgraph = g.extractSubgraph(root.id);
		expect(subgraph).toHaveLength(4);
		expect(subgraph.map((n) => n.label)).toEqual([
			"explore the root directory",
			"scan the first child",
			"inspect the nested grandchild",
			"scan the second child",
		]);
	});

	it("extractSubgraph returns empty for missing node", () => {
		const g = new PlanGraph("p1", "test", join(dir, "plan.json"));
		expect(g.extractSubgraph("nonexistent")).toEqual([]);
	});

	it("createScoped builds a scoped plan from subgraph", () => {
		const g = new PlanGraph("p1", "parent plan", join(dir, "plan.json"));
		g.setInception("current", "desired", "delta");
		g.setEndState("done");
		const root = g.addNode("delegate this entire task");
		g.addNode("complete subtask part A", root.id);
		g.addNode("complete subtask part B", root.id);

		const subgraph = g.extractSubgraph(root.id);
		const scoped = PlanGraph.createScoped(
			"p1",
			root.id,
			subgraph,
			"delegate this entire task",
			{ current: "c", desired: "d", delta: "x" },
			join(dir, "scoped.json"),
		);

		expect(scoped.isScoped()).toBe(true);
		expect(scoped.getParentPlanId()).toBe("p1");
		expect(scoped.phase).toBe("implementation");
		expect(scoped.stats().total).toBe(3);
	});

	it("applyChildUpdate updates node status", () => {
		const g = new PlanGraph("p1", "parent", join(dir, "plan.json"));
		g.setInception("a", "b", "c");
		g.setEndState("done");
		const n = g.addNode("work on this task");

		expect(g.applyChildUpdate({ planId: "p1", nodeId: n.id, action: "checkpoint" })).toBe(true);
		expect(g.getNode(n.id)!.status).toBe("active");

		expect(g.applyChildUpdate({ planId: "p1", nodeId: n.id, action: "complete" })).toBe(true);
		expect(g.getNode(n.id)!.status).toBe("done");
	});

	it("applyChildUpdate returns false for missing node", () => {
		const g = new PlanGraph("p1", "parent", join(dir, "plan.json"));
		expect(g.applyChildUpdate({ planId: "p1", nodeId: "missing", action: "checkpoint" })).toBe(false);
	});

	it("renderFocusedTree folds non-active branches with counts", () => {
		const g = new PlanGraph("p1", "focus test", join(dir, "plan.json"));
		g.setInception("a", "b", "c");
		g.setEndState("done");
		const phase1 = g.addNode("complete the first phase");
		g.addNode("finish subtask one A", phase1.id);
		g.addNode("finish subtask one B", phase1.id);
		const phase2 = g.addNode("complete the second phase");
		const active = g.addNode("implement the active task", phase2.id);
		g.addNode("handle the remaining work", phase2.id);
		g.checkpoint(active.id);

		const tree = g.renderFocusedTree();
		expect(tree).toContain("[0/2]");
		expect(tree).toContain("implement the active task");
		expect(tree).toContain("◄");
		expect(tree).toContain("handle the remaining work");
		expect(tree).not.toContain("finish subtask one A");
	});

	it("renderFocusedTree shows agent names on delegated nodes", () => {
		const g = new PlanGraph("p1", "agent test", join(dir, "plan.json"));
		g.setInception("a", "b", "c");
		g.setEndState("done");
		const n = g.addNode("task delegated to agent");
		const node = g.getNode(n.id)!;
		node.delegatedTo = { agentProfile: "explorer", delegatedAt: Date.now() };
		g.checkpoint(n.id);

		const tree = g.renderFocusedTree();
		expect(tree).toContain("@explorer");
	});

	it("applyChildUpdate handles expand action", () => {
		const g = new PlanGraph("p1", "parent", join(dir, "plan.json"));
		g.setInception("a", "b", "c");
		g.setEndState("done");
		const root = g.addNode("organize the root level");

		g.applyChildUpdate({
			planId: "p1",
			nodeId: root.id,
			action: "expand",
			payload: { label: "add a new child node", parentId: root.id },
		});

		expect(g.children(root.id)).toHaveLength(1);
		expect(g.children(root.id)[0].label).toBe("add a new child node");
	});
});
