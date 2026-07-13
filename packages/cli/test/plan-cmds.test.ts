import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlanStore } from "@dpopsuev/alef-tool-plan";
import { afterEach, describe, expect, it, vi } from "vitest";
import { plan } from "../src/client/commands/plan-cmds.js";
import type { TuiHandlerContext } from "../src/client/commands/types.js";

describe(":plan commands", { tags: ["unit"] }, () => {
	const tmps: string[] = [];
	const previousXdg = process.env.XDG_DATA_HOME;

	function makeWorkspace(): string {
		const dataHome = mkdtempSync(join(tmpdir(), "alef-plan-home-"));
		tmps.push(dataHome);
		process.env.XDG_DATA_HOME = dataHome;
		const cwd = join(dataHome, "ws");
		mkdirSync(cwd);
		return cwd;
	}

	afterEach(() => {
		if (previousXdg === undefined) delete process.env.XDG_DATA_HOME;
		else process.env.XDG_DATA_HOME = previousXdg;
		for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	function makeCtx(cwd: string) {
		const notices: string[] = [];
		const ctx = {
			opts: { cwd },
			writer: { addNotice: (text: string) => notices.push(text) },
			tui: { requestRender: vi.fn(), stop: vi.fn() },
			session: { state: { id: "s1", modelId: "test" } },
		} as unknown as TuiHandlerContext;
		return { ctx, notices };
	}

	it("shows none when no focused plan", () => {
		const cwd = makeWorkspace();
		const { ctx, notices } = makeCtx(cwd);
		plan.run(ctx, []);
		expect(notices.at(-1)).toContain("No focused plan");
	});

	it("lists plans and focuses by id", () => {
		const cwd = makeWorkspace();
		const { ctx, notices } = makeCtx(cwd);
		const store = new PlanStore({ cwd });
		const first = store.create("a", "first goal", "x");
		store.create("b", "second goal", "x");

		plan.run(ctx, ["list"]);
		expect(notices.at(-1)).toContain("first goal");
		expect(notices.at(-1)).toContain("second goal");

		plan.run(ctx, ["focus", first.id]);
		expect(notices.at(-1)).toContain(first.id);
		expect(new PlanStore({ cwd }).focused()?.id).toBe(first.id);
	});

	it("backlogs the focused plan", () => {
		const cwd = makeWorkspace();
		const { ctx, notices } = makeCtx(cwd);
		new PlanStore({ cwd }).create("a", "goal", "x");

		plan.run(ctx, ["backlog"]);
		expect(notices.at(-1)).toMatch(/backlog/i);
		expect(new PlanStore({ cwd }).focused()).toBeNull();
	});
});
