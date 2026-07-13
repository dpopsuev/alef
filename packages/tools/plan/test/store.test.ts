import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PlanStore } from "../src/store.js";

describe("PlanStore", { tags: ["unit"] }, () => {
	const tmps: string[] = [];
	function makeRoot(): string {
		const d = mkdtempSync(join(tmpdir(), "alef-plan-store-"));
		tmps.push(d);
		return d;
	}

	afterEach(() => {
		for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	it("create focuses the new plan and lists it as active", () => {
		const root = makeRoot();
		const store = new PlanStore({ cwd: "/proj", plansRoot: root });
		const plan = store.create("no watchers", "stateful services shipped", "tests pass");

		expect(plan.desired).toBe("stateful services shipped");
		expect(store.focused()?.id).toBe(plan.id);
		expect(store.list()).toEqual([
			expect.objectContaining({ id: plan.id, status: "active", desired: "stateful services shipped" }),
		]);
	});

	it("create auto-backlogs the previous focused plan", () => {
		const root = makeRoot();
		const store = new PlanStore({ cwd: "/proj", plansRoot: root });
		const first = store.create("a", "first goal", "done");
		const second = store.create("b", "second goal", "done");

		const entries = store.list();
		expect(store.focused()?.id).toBe(second.id);
		expect(entries.find((e) => e.id === first.id)?.status).toBe("backlog");
		expect(entries.find((e) => e.id === second.id)?.status).toBe("active");
	});

	it("focus switches active plan and backlogs the prior", () => {
		const root = makeRoot();
		const store = new PlanStore({ cwd: "/proj", plansRoot: root });
		const first = store.create("a", "first goal", "done");
		const second = store.create("b", "second goal", "done");

		store.focus(first.id);

		expect(store.focused()?.id).toBe(first.id);
		expect(store.list().find((e) => e.id === second.id)?.status).toBe("backlog");
		expect(store.list().find((e) => e.id === first.id)?.status).toBe("active");
	});

	it("backlog demotes the focused plan without closing it", () => {
		const root = makeRoot();
		const store = new PlanStore({ cwd: "/proj", plansRoot: root });
		const plan = store.create("a", "goal", "done");

		store.backlog();

		expect(store.focused()).toBeNull();
		expect(store.list().find((e) => e.id === plan.id)?.status).toBe("backlog");
		expect(store.load(plan.id)?.phase).toBe("open");
	});

	it("close marks plan closed and clears focus", () => {
		const root = makeRoot();
		const store = new PlanStore({ cwd: "/proj", plansRoot: root });
		const plan = store.create("a", "goal", "done");

		store.close(plan.id, "shipped");

		expect(store.focused()).toBeNull();
		expect(store.list().find((e) => e.id === plan.id)?.status).toBe("closed");
		expect(store.load(plan.id)?.phase).toBe("closed");
	});

	it("list can filter by status", () => {
		const root = makeRoot();
		const store = new PlanStore({ cwd: "/proj", plansRoot: root });
		const first = store.create("a", "first", "x");
		store.create("b", "second", "x");
		store.close(first.id, "done");

		expect(store.list({ status: "active" })).toHaveLength(1);
		expect(store.list({ status: "closed" })).toHaveLength(1);
		expect(store.list({ status: "backlog" })).toHaveLength(0);
	});

	it("persists across store instances", () => {
		const root = makeRoot();
		const a = new PlanStore({ cwd: "/proj", plansRoot: root });
		const plan = a.create("now", "later", "verify");

		const b = new PlanStore({ cwd: "/proj", plansRoot: root });
		expect(b.focused()?.id).toBe(plan.id);
		expect(b.list()).toHaveLength(1);
	});
});
