import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adapterComplianceSuite } from "@dpopsuev/alef-testkit/organ";
import { afterEach, describe, expect, it } from "vitest";
import { createPlanAdapter } from "../src/adapter.js";
import { PlanGraph } from "../src/graph.js";

adapterComplianceSuite(() => createPlanAdapter({ sessionDir: mkdtempSync(join(tmpdir(), "alef-plan-compliance-")) }));

describe("PlanGraph", { tags: ["unit"] }, () => {
	const tmps: string[] = [];
	function makeTmp(): string {
		const d = mkdtempSync(join(tmpdir(), "alef-plan-"));
		tmps.push(d);
		return d;
	}

	afterEach(() => {
		for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	it("constructor creates a plan in open phase", () => {
		const plan = new PlanGraph("p1", "no docs", "6 doc pages", "all pages exist", null);
		expect(plan.phase).toBe("open");
		expect(plan.current).toBe("no docs");
		expect(plan.desired).toBe("6 doc pages");
		expect(plan.verify).toBe("all pages exist");
	});

	it("addStep creates steps with correct IDs and tree structure", () => {
		const plan = new PlanGraph("p1", "a", "b", "c", null);
		const root = plan.addStep("create the index page", null);
		const child = plan.addStep("add navigation links", root.id);
		expect(root.id).toBe("create-the-index-page");
		expect(child.parent).toBe(root.id);
		expect(child.depth).toBe(1);
		expect(plan.children(null)).toHaveLength(1);
		expect(plan.children(root.id)).toHaveLength(1);
	});

	it("addStep rejects labels that are too short or too long", () => {
		const plan = new PlanGraph("p1", "a", "b", "c", null);
		expect(() => plan.addStep("ab", null)).toThrow(/too short/);
		expect(() => plan.addStep("a b c d e f g h i j k l m", null)).toThrow(/too long/);
	});

	it("startStep transitions to active and advances plan to working", () => {
		const plan = new PlanGraph("p1", "a", "b", "c", null);
		plan.addStep("create the index page", null);
		const started = plan.startStep("create-the-index-page");
		expect(started?.status).toBe("active");
		expect(plan.phase).toBe("working");
	});

	it("completeStep with no gates marks step as done", () => {
		const plan = new PlanGraph("p1", "a", "b", "c", null);
		plan.addStep("create the index page", null);
		plan.startStep("create-the-index-page");
		const result = plan.completeStep("create-the-index-page", "created");
		expect(result?.step.status).toBe("done");
		expect(result?.gateResults).toHaveLength(0);
	});

	it("completeStep with passing file-exists gate marks done", () => {
		const dir = makeTmp();
		writeFileSync(join(dir, "index.md"), "# Index");
		const plan = new PlanGraph("p1", "a", "b", "c", null);
		plan.addStep("create the index page", null, [{ type: "file-exists", target: join(dir, "index.md") }]);
		plan.startStep("create-the-index-page");
		const result = plan.completeStep("create-the-index-page");
		expect(result?.step.status).toBe("done");
		expect(result?.gateResults[0]?.passed).toBe(true);
	});

	it("completeStep with failing file-exists gate marks failed", () => {
		const plan = new PlanGraph("p1", "a", "b", "c", null);
		plan.addStep("create the index page", null, [{ type: "file-exists", target: "/nonexistent/file.md" }]);
		plan.startStep("create-the-index-page");
		const result = plan.completeStep("create-the-index-page");
		expect(result?.step.status).toBe("failed");
		expect(result?.gateResults[0]?.passed).toBe(false);
	});

	it("completeStep with contains gate checks file content", () => {
		const dir = makeTmp();
		writeFileSync(join(dir, "index.md"), "# Index\n\n[Getting Started](getting-started.md)");
		const plan = new PlanGraph("p1", "a", "b", "c", null);
		plan.addStep("create the index page", null, [{ type: "contains", target: join(dir, "index.md"), expect: "getting-started.md" }]);
		plan.startStep("create-the-index-page");
		const result = plan.completeStep("create-the-index-page");
		expect(result?.step.status).toBe("done");
	});

	it("failStep marks step as failed with reason", () => {
		const plan = new PlanGraph("p1", "a", "b", "c", null);
		plan.addStep("create the index page", null);
		plan.startStep("create-the-index-page");
		const step = plan.failStep("create-the-index-page", "couldn't figure it out");
		expect(step?.status).toBe("failed");
		expect(step?.result).toBe("couldn't figure it out");
	});

	it("failed step can be restarted", () => {
		const plan = new PlanGraph("p1", "a", "b", "c", null);
		plan.addStep("create the index page", null);
		plan.startStep("create-the-index-page");
		plan.failStep("create-the-index-page", "first attempt failed");
		const retried = plan.startStep("create-the-index-page");
		expect(retried?.status).toBe("active");
	});

	it("dropStep marks step as dropped", () => {
		const plan = new PlanGraph("p1", "a", "b", "c", null);
		plan.addStep("create the index page", null);
		const step = plan.dropStep("create-the-index-page");
		expect(step?.status).toBe("dropped");
	});

	it("nextReady returns first pending root step", () => {
		const plan = new PlanGraph("p1", "a", "b", "c", null);
		plan.addStep("create the index page", null);
		plan.addStep("write the getting started guide", null);
		expect(plan.nextReady()?.id).toBe("create-the-index-page");
	});

	it("nextReady returns child step when parent is active", () => {
		const plan = new PlanGraph("p1", "a", "b", "c", null);
		const root = plan.addStep("write the documentation site", null);
		plan.addStep("create the index page", root.id);
		expect(plan.nextReady()?.id).toBe("write-the-documentation-site");
		plan.startStep("write-the-documentation-site");
		expect(plan.nextReady()?.id).toBe("create-the-index-page");
	});

	it("amend updates current/desired/verify", () => {
		const plan = new PlanGraph("p1", "a", "b", "c", null);
		plan.amend({ current: "updated current", desired: "updated desired" });
		expect(plan.current).toBe("updated current");
		expect(plan.desired).toBe("updated desired");
		expect(plan.verify).toBe("c");
	});

	it("close sets phase to closed and stores summary", () => {
		const plan = new PlanGraph("p1", "a", "b", "c", null);
		plan.close("all done");
		expect(plan.phase).toBe("closed");
		const data = plan.toJSON();
		expect(data.summary).toBe("all done");
	});

	it("stats returns correct counts", () => {
		const plan = new PlanGraph("p1", "a", "b", "c", null);
		plan.addStep("create the index page", null);
		plan.addStep("write the getting started guide", null);
		plan.addStep("write the architecture guide", null);
		plan.startStep("create-the-index-page");
		plan.completeStep("create-the-index-page");
		plan.dropStep("write-the-architecture-guide");
		const s = plan.stats();
		expect(s.total).toBe(3);
		expect(s.done).toBe(1);
		expect(s.pending).toBe(1);
		expect(s.dropped).toBe(1);
	});

	it("renderSummary includes current/desired/verify and tree", () => {
		const plan = new PlanGraph("p1", "no docs", "6 pages", "all exist", null);
		plan.addStep("create the index page", null);
		const summary = plan.renderSummary();
		expect(summary).toContain("Current: no docs");
		expect(summary).toContain("Desired: 6 pages");
		expect(summary).toContain("Verify: all exist");
		expect(summary).toContain("create-the-index-page");
	});

	it("persists to disk and loads back", () => {
		const dir = makeTmp();
		const path = join(dir, "plan.json");
		const plan = new PlanGraph("p1", "a", "b", "c", path);
		plan.addStep("create the index page", null);
		plan.startStep("create-the-index-page");

		const loaded = PlanGraph.load(path);
		expect(loaded).not.toBeNull();
		expect(loaded!.phase).toBe("working");
		expect(loaded!.getStep("create-the-index-page")?.status).toBe("active");
	});

	it("step with inspector stores inspector definition", () => {
		const plan = new PlanGraph("p1", "a", "b", "c", null);
		const step = plan.addStep("create the index page", null, [], { type: "functional", prompt: "check links exist" });
		expect(step.inspector?.type).toBe("functional");
		expect(step.inspector?.prompt).toBe("check links exist");
	});
});
