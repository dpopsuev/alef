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

	it("plan.handoff and plan.custody transfer and show custody", async () => {
		const cwd = makeCwd();
		const h = harness(cwd);
		await h.ready();

		await h.send("plan.open", { current: "a", desired: "ship factory handoff", verify: "custody set" });
		const handed = await h.send("plan.handoff", {
			to: "@director",
			from: "@coordinator",
			note: "take the line",
		});
		expect(handed.isError).toBe(false);
		expect(handed.payload.custody).toEqual(
			expect.objectContaining({ owner: "@director", from: "@coordinator", note: "take the line" }),
		);
		expect(typeof handed.payload.token).toBe("string");

		const shown = await h.send("plan.custody", {});
		expect(shown.isError).toBe(false);
		expect(shown.payload.custody).toEqual(expect.objectContaining({ owner: "@director" }));
		const display = shown.payload._display as { text?: string } | undefined;
		expect(String(display?.text ?? "")).toContain("@director");
		h.dispose();
	});

	it("plan.ready lists unclaimed ready steps after plan.steps", async () => {
		const cwd = makeCwd();
		const h = harness(cwd);
		await h.ready();

		await h.send("plan.open", { current: "a", desired: "ship change", verify: "pr merged" });
		const steps = await h.send("plan.steps", {
			steps: [{ label: "Implement factory roles" }],
		});
		expect(steps.isError).toBe(false);
		const ready = await h.send("plan.ready", {});
		expect(ready.isError).toBe(false);
		expect(ready.payload.ready).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ label: "Implement factory roles", roleHint: "worker.coder" }),
			]),
		);
		h.dispose();
	});
});
