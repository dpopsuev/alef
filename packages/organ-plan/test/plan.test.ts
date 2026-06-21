import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { organComplianceSuite } from "@dpopsuev/alef-testkit/organ";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PlanGraph } from "../src/graph.js";
import { createPlanOrgan } from "../src/organ.js";

organComplianceSuite(() => createPlanOrgan({ sessionDir: mkdtempSync(join(tmpdir(), "alef-plan-compliance-")) }));

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
		const n0 = g.addNode("read code");
		g.addNode("extract helper A", n0.id);
		const n2 = g.addNode("extract helper B", n0.id);
		expect(g.children(n0.id)).toHaveLength(2);
		g.pruneNode(n2.id);
		expect(g.stats().pruned).toBe(1);
	});

	it("persists and reloads from disk", () => {
		const path = join(dir, "plan.json");
		const g = new PlanGraph("p1", "test persist", path);
		g.setInception("before", "after", "change it");
		g.addNode("step 1");
		const loaded = PlanGraph.load(path);
		expect(loaded).not.toBeNull();
		expect(loaded!.phase).toBe("expansion");
		expect(loaded!.stats().total).toBe(1);
	});

	it("renders a tree", () => {
		const g = new PlanGraph("p1", "render test", join(dir, "plan.json"));
		g.setInception("a", "b", "c");
		g.setEndState("done");
		const root = g.addNode("root task");
		g.addNode("subtask 1", root.id);
		g.addNode("subtask 2", root.id);
		const tree = g.renderTree();
		expect(tree).toContain("root task");
		expect(tree).toContain("subtask 1");
		expect(tree).toContain("subtask 2");
	});

	it("enforces forward-only phase transitions", () => {
		const g = new PlanGraph("p1", "test", join(dir, "plan.json"));
		g.setInception("a", "b", "c");
		const err = g.advanceTo("intention");
		expect(err).toContain("cannot go back");
	});

	it("extractSubgraph returns subtree rooted at node", () => {
		const g = new PlanGraph("p1", "extract test", join(dir, "plan.json"));
		g.setInception("a", "b", "c");
		g.setEndState("done");
		const root = g.addNode("root");
		const child1 = g.addNode("child 1", root.id);
		g.addNode("grandchild", child1.id);
		g.addNode("child 2", root.id);
		g.addNode("sibling");

		const subgraph = g.extractSubgraph(root.id);
		expect(subgraph).toHaveLength(4);
		expect(subgraph.map((n) => n.label)).toEqual(["root", "child 1", "grandchild", "child 2"]);
	});

	it("extractSubgraph returns empty for missing node", () => {
		const g = new PlanGraph("p1", "test", join(dir, "plan.json"));
		expect(g.extractSubgraph("nonexistent")).toEqual([]);
	});

	it("createScoped builds a scoped plan from subgraph", () => {
		const g = new PlanGraph("p1", "parent plan", join(dir, "plan.json"));
		g.setInception("current", "desired", "delta");
		g.setEndState("done");
		const root = g.addNode("delegated task");
		g.addNode("subtask A", root.id);
		g.addNode("subtask B", root.id);

		const subgraph = g.extractSubgraph(root.id);
		const scoped = PlanGraph.createScoped(
			"p1",
			root.id,
			subgraph,
			"delegated task",
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
		const n = g.addNode("task");

		expect(g.applyChildUpdate({ planId: "p1", nodeId: n.id, action: "checkpoint" })).toBe(true);
		expect(g.getNode(n.id)!.status).toBe("active");

		expect(g.applyChildUpdate({ planId: "p1", nodeId: n.id, action: "complete" })).toBe(true);
		expect(g.getNode(n.id)!.status).toBe("done");
	});

	it("applyChildUpdate returns false for missing node", () => {
		const g = new PlanGraph("p1", "parent", join(dir, "plan.json"));
		expect(g.applyChildUpdate({ planId: "p1", nodeId: "missing", action: "checkpoint" })).toBe(false);
	});

	it("applyChildUpdate handles expand action", () => {
		const g = new PlanGraph("p1", "parent", join(dir, "plan.json"));
		g.setInception("a", "b", "c");
		g.setEndState("done");
		const root = g.addNode("root");

		g.applyChildUpdate({
			planId: "p1",
			nodeId: root.id,
			action: "expand",
			payload: { label: "new child", parentId: root.id },
		});

		expect(g.children(root.id)).toHaveLength(1);
		expect(g.children(root.id)[0].label).toBe("new child");
	});
});
