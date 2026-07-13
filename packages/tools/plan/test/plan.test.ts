import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adapterComplianceSuite } from "@dpopsuev/alef-testkit/adapter";
import { afterEach, describe, expect, it } from "vitest";
import { createPlanAdapter } from "../src/adapter.js";
import { PlanGraph } from "../src/graph.js";

adapterComplianceSuite(() => createPlanAdapter({ cwd: mkdtempSync(join(tmpdir(), "alef-plan-compliance-")) }));

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

	it("addStep creates steps with correct IDs", () => {
		const plan = new PlanGraph("p1", "a", "b", "c", null);
		const step = plan.addStep("create the index page");
		expect(step.id).toBe("create-the-index-page");
		expect(step.dependsOn).toEqual([]);
	});

	it("addStep with dependsOn links steps", () => {
		const plan = new PlanGraph("p1", "a", "b", "c", null);
		const a = plan.addStep("create the index page");
		const b = plan.addStep("add navigation links", [a.id]);
		expect(b.dependsOn).toEqual([a.id]);
		expect(plan.dependents(a.id)).toHaveLength(1);
		expect(plan.dependents(a.id)[0]?.id).toBe(b.id);
	});

	it("addStep rejects labels that are too short or too long", () => {
		const plan = new PlanGraph("p1", "a", "b", "c", null);
		expect(() => plan.addStep("ab")).toThrow(/too short/);
		expect(() => plan.addStep("a b c d e f g h i j k l m")).toThrow(/too long/);
	});

	it("addStep rejects unknown dependency", () => {
		const plan = new PlanGraph("p1", "a", "b", "c", null);
		expect(() => plan.addStep("create the index page", ["nonexistent"])).toThrow(/not found/);
	});

	it("startStep transitions to active and advances plan to working", () => {
		const plan = new PlanGraph("p1", "a", "b", "c", null);
		plan.addStep("create the index page");
		const started = plan.startStep("create-the-index-page");
		expect(started?.status).toBe("active");
		expect(plan.phase).toBe("working");
	});

	it("completeStep with no gates marks step as done", () => {
		const plan = new PlanGraph("p1", "a", "b", "c", null);
		plan.addStep("create the index page");
		plan.startStep("create-the-index-page");
		const result = plan.completeStep("create-the-index-page", "created");
		expect(result?.step.status).toBe("done");
		expect(result?.gateResults).toHaveLength(0);
	});

	it("completeStep with passing file-exists gate marks done", () => {
		const dir = makeTmp();
		writeFileSync(join(dir, "index.md"), "# Index");
		const plan = new PlanGraph("p1", "a", "b", "c", null);
		plan.addStep("create the index page", [], [{ type: "file-exists", target: join(dir, "index.md") }]);
		plan.startStep("create-the-index-page");
		const result = plan.completeStep("create-the-index-page");
		expect(result?.step.status).toBe("done");
		expect(result?.gateResults[0]?.passed).toBe(true);
	});

	it("completeStep with failing file-exists gate marks failed", () => {
		const plan = new PlanGraph("p1", "a", "b", "c", null);
		plan.addStep("create the index page", [], [{ type: "file-exists", target: "/nonexistent/file.md" }]);
		plan.startStep("create-the-index-page");
		const result = plan.completeStep("create-the-index-page");
		expect(result?.step.status).toBe("failed");
		expect(result?.gateResults[0]?.passed).toBe(false);
	});

	it("completeStep with contains gate checks file content", () => {
		const dir = makeTmp();
		writeFileSync(join(dir, "index.md"), "# Index\n\n[Getting Started](getting-started.md)");
		const plan = new PlanGraph("p1", "a", "b", "c", null);
		plan.addStep("create the index page", [], [{ type: "contains", target: join(dir, "index.md"), expect: "getting-started.md" }]);
		plan.startStep("create-the-index-page");
		const result = plan.completeStep("create-the-index-page");
		expect(result?.step.status).toBe("done");
	});

	it("failStep marks step as failed with reason", () => {
		const plan = new PlanGraph("p1", "a", "b", "c", null);
		plan.addStep("create the index page");
		plan.startStep("create-the-index-page");
		const step = plan.failStep("create-the-index-page", "couldn't figure it out");
		expect(step?.status).toBe("failed");
		expect(step?.result).toBe("couldn't figure it out");
	});

	it("failed step can be restarted", () => {
		const plan = new PlanGraph("p1", "a", "b", "c", null);
		plan.addStep("create the index page");
		plan.startStep("create-the-index-page");
		plan.failStep("create-the-index-page", "first attempt failed");
		const retried = plan.startStep("create-the-index-page");
		expect(retried?.status).toBe("active");
	});

	it("dropStep marks step as dropped", () => {
		const plan = new PlanGraph("p1", "a", "b", "c", null);
		plan.addStep("create the index page");
		const step = plan.dropStep("create-the-index-page");
		expect(step?.status).toBe("dropped");
	});

	it("nextReady returns first pending root step", () => {
		const plan = new PlanGraph("p1", "a", "b", "c", null);
		plan.addStep("create the index page");
		plan.addStep("write the getting started guide");
		expect(plan.nextReady()?.id).toBe("create-the-index-page");
	});

	describe("DAG fan-in / fan-out", () => {
		it("fan-out: completing A makes B and C eligible", () => {
			const plan = new PlanGraph("p1", "a", "b", "c", null);
			const a = plan.addStep("define the base interfaces");
			plan.addStep("write the api reference docs", [a.id]);
			plan.addStep("write the architecture docs", [a.id]);

			expect(plan.allReady()).toHaveLength(1);
			expect(plan.nextReady()?.id).toBe(a.id);

			plan.startStep(a.id);
			plan.completeStep(a.id);

			const ready = plan.allReady();
			expect(ready).toHaveLength(2);
			expect(ready.map((s) => s.id).sort()).toEqual(["write-the-api-reference-docs", "write-the-architecture-docs"]);
		});

		it("fan-in: E waits for both C and D", () => {
			const plan = new PlanGraph("p1", "a", "b", "c", null);
			const c = plan.addStep("write the api reference docs");
			const d = plan.addStep("write the architecture docs");
			plan.addStep("build the index page linking everything", [c.id, d.id]);

			plan.startStep(c.id);
			plan.completeStep(c.id);
			expect(plan.nextReady()?.id).toBe(d.id);

			plan.startStep(d.id);
			plan.completeStep(d.id);
			expect(plan.nextReady()?.id).toBe("build-the-index-page-linking-everything");
		});

		it("diamond: A→B, A→C, B→D, C→D", () => {
			const plan = new PlanGraph("p1", "a", "b", "c", null);
			const a = plan.addStep("define the base interfaces");
			const b = plan.addStep("write the api reference docs", [a.id]);
			const cc = plan.addStep("write the architecture docs", [a.id]);
			plan.addStep("build the index page linking everything", [b.id, cc.id]);

			plan.startStep(a.id);
			plan.completeStep(a.id);
			expect(plan.allReady()).toHaveLength(2);

			plan.startStep(b.id);
			plan.completeStep(b.id);
			expect(plan.nextReady()?.id).toBe(cc.id);

			plan.startStep(cc.id);
			plan.completeStep(cc.id);
			expect(plan.nextReady()?.id).toBe("build-the-index-page-linking-everything");
		});

		it("allReady returns all eligible steps for parallel dispatch", () => {
			const plan = new PlanGraph("p1", "a", "b", "c", null);
			plan.addStep("write the api reference docs");
			plan.addStep("write the architecture docs");
			plan.addStep("write the contributing guide");

			expect(plan.allReady()).toHaveLength(3);
		});
	});

	describe("cycle detection", () => {
		it("rejects step addition that would create a cycle", () => {
			const plan = new PlanGraph("p1", "a", "b", "c", null);
			const a = plan.addStep("define the base interfaces");
			const b = plan.addStep("write the api reference docs", [a.id]);
			expect(() => plan.addStep("create a circular dependency", [b.id])).not.toThrow();

			const plan2 = new PlanGraph("p2", "a", "b", "c", null);
			const x = plan2.addStep("define the base interfaces");
			const y = plan2.addStep("write the api reference docs", [x.id]);
			const zz = plan2.addStep("write the architecture docs", [y.id]);
			expect(() => {
				plan2.addStep("create circular loop back", [zz.id]);
			}).not.toThrow();
		});
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
		plan.addStep("create the index page");
		plan.addStep("write the getting started guide");
		plan.addStep("write the architecture guide");
		plan.startStep("create-the-index-page");
		plan.completeStep("create-the-index-page");
		plan.dropStep("write-the-architecture-guide");
		const s = plan.stats();
		expect(s.total).toBe(3);
		expect(s.done).toBe(1);
		expect(s.pending).toBe(1);
		expect(s.dropped).toBe(1);
	});

	it("renderSummary includes current/desired/verify and steps", () => {
		const plan = new PlanGraph("p1", "no docs", "6 pages", "all exist", null);
		plan.addStep("create the index page");
		const summary = plan.renderSummary();
		expect(summary).toContain("Current: no docs");
		expect(summary).toContain("Desired: 6 pages");
		expect(summary).toContain("Verify: all exist");
		expect(summary).toContain("create-the-index-page");
	});

	it("renderTree shows header counts and step labels", () => {
		const plan = new PlanGraph("p1", "a", "b", "c", null);
		const a = plan.addStep("define the base interfaces");
		plan.addStep("write the api reference docs", [a.id]);
		plan.startStep(a.id);
		const tree = plan.renderTree();
		expect(tree).toContain("Plan · working on 1 · 0/2 done");
		expect(tree).toContain("● define the base interfaces");
		expect(tree).toContain("○ write the api reference docs");
		expect(tree).not.toContain("├──");
	});

	it("renderSummary includes step labels from sticky tree", () => {
		const plan = new PlanGraph("p1", "a", "b", "c", null);
		const a = plan.addStep("define the base interfaces");
		const b = plan.addStep("write the api reference docs", [a.id]);
		plan.addStep("build the final index page", [a.id, b.id]);
		const summary = plan.renderSummary();
		expect(summary).toContain("build the final index page");
		expect(summary).toContain("Plan · working on 1 · 0/3 done");
	});

	it("persists to disk and loads back", () => {
		const dir = makeTmp();
		const path = join(dir, "graph-persist.json");
		const plan = new PlanGraph("p1", "a", "b", "c", path);
		plan.addStep("create the index page");
		plan.startStep("create-the-index-page");

		const loaded = PlanGraph.load(path);
		expect(loaded).not.toBeNull();
		expect(loaded!.phase).toBe("working");
		expect(loaded!.getStep("create-the-index-page")?.status).toBe("active");
	});

	it("step with inspector stores inspector definition", () => {
		const plan = new PlanGraph("p1", "a", "b", "c", null);
		const step = plan.addStep("create the index page", [], [], { type: "functional", prompt: "check links exist" });
		expect(step.inspector?.type).toBe("functional");
		expect(step.inspector?.prompt).toBe("check links exist");
	});

	it("roots returns steps with no dependencies", () => {
		const plan = new PlanGraph("p1", "a", "b", "c", null);
		const a = plan.addStep("create the index page");
		plan.addStep("add navigation links", [a.id]);
		plan.addStep("write the contributing guide");
		expect(plan.roots()).toHaveLength(2);
	});
});
