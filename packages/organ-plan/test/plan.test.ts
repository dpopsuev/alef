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
});
