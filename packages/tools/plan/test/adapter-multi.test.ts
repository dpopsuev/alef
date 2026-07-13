import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterHarness } from "@dpopsuev/alef-testkit/adapter";
import { afterEach, describe, expect, it } from "vitest";
import { createPlanAdapter } from "../src/adapter.js";

describe("plan adapter multi-plan", { tags: ["unit"] }, () => {
	const tmps: string[] = [];
	function makeCwd(): string {
		const d = mkdtempSync(join(tmpdir(), "alef-plan-adapter-"));
		tmps.push(d);
		return d;
	}

	afterEach(() => {
		for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	function harness(cwd: string) {
		const plansRoot = join(cwd, ".plans");
		return new AdapterHarness(createPlanAdapter({ cwd, plansRoot }));
	}

	it("plan.open backlogs previous and plan.list shows both", async () => {
		const cwd = makeCwd();
		const h = harness(cwd);
		await h.ready();

		const first = await h.send("plan.open", {
			current: "a",
			desired: "first goal",
			verify: "done",
		});
		expect(first.isError).toBe(false);

		const second = await h.send("plan.open", {
			current: "b",
			desired: "second goal",
			verify: "done",
		});
		expect(second.isError).toBe(false);

		const listed = await h.send("plan.list", {});
		expect(listed.isError).toBe(false);
		expect(listed.payload.plans).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ desired: "first goal", status: "backlog" }),
				expect.objectContaining({ desired: "second goal", status: "active" }),
			]),
		);
		h.dispose();
	});

	it("plan.focus switches the active plan", async () => {
		const cwd = makeCwd();
		const h = harness(cwd);
		await h.ready();

		const first = await h.send("plan.open", { current: "a", desired: "first goal", verify: "x" });
		const firstId = String(first.payload.id);
		await h.send("plan.open", { current: "b", desired: "second goal", verify: "x" });

		const focused = await h.send("plan.focus", { id: firstId });
		expect(focused.isError).toBe(false);
		expect(focused.payload.id).toBe(firstId);

		const show = await h.send("plan.show", {});
		expect(show.payload.id).toBe(firstId);
		expect(show.payload.desired).toBe("first goal");
		h.dispose();
	});

	it("plan.backlog clears focus", async () => {
		const cwd = makeCwd();
		const h = harness(cwd);
		await h.ready();

		await h.send("plan.open", { current: "a", desired: "goal", verify: "x" });
		const result = await h.send("plan.backlog", {});
		expect(result.isError).toBe(false);

		const show = await h.send("plan.show", {});
		expect(show.payload.active).toBe(false);
		h.dispose();
	});
});
