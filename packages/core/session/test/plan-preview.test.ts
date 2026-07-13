import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPlanPreview } from "../src/context/plan-preview.js";
import { cwdHash } from "../src/store.js";

describe("loadPlanPreview", { tags: ["unit"] }, () => {
	const tmps: string[] = [];
	const previousXdg = process.env.XDG_DATA_HOME;

	afterEach(() => {
		if (previousXdg === undefined) delete process.env.XDG_DATA_HOME;
		else process.env.XDG_DATA_HOME = previousXdg;
		for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	it("loads the focused plan from the XDG plan shelf", async () => {
		const dataHome = mkdtempSync(join(tmpdir(), "alef-plan-preview-"));
		tmps.push(dataHome);
		process.env.XDG_DATA_HOME = dataHome;
		const cwd = join(dataHome, "ws");
		mkdirSync(cwd);
		const root = join(dataHome, "alef", "plans", cwdHash(cwd));
		mkdirSync(root, { recursive: true });
		writeFileSync(
			join(root, "index.json"),
			JSON.stringify({ focusedId: "plan-abc", entries: [{ id: "plan-abc", desired: "ship it", phase: "working", updatedAt: 1 }] }),
		);
		writeFileSync(
			join(root, "plan-abc.json"),
			JSON.stringify({
				id: "plan-abc",
				phase: "working",
				current: "partial",
				desired: "ship it",
				verify: "tests green",
				steps: [{ id: "step-1", status: "active" }, { id: "step-2", status: "pending" }],
				createdAt: 1,
				updatedAt: 2,
			}),
		);

		const preview = await loadPlanPreview(cwd);
		expect(preview).toEqual({
			phase: "working",
			desired: "ship it",
			current: "partial",
			stepSummary: "0/2 done · active: step-1",
		});
	});

	it("returns undefined when nothing is focused", async () => {
		const dataHome = mkdtempSync(join(tmpdir(), "alef-plan-preview-"));
		tmps.push(dataHome);
		process.env.XDG_DATA_HOME = dataHome;
		const cwd = join(dataHome, "ws");
		mkdirSync(cwd);
		const root = join(dataHome, "alef", "plans", cwdHash(cwd));
		mkdirSync(root, { recursive: true });
		writeFileSync(join(root, "index.json"), JSON.stringify({ focusedId: null, entries: [] }));

		expect(await loadPlanPreview(cwd)).toBeUndefined();
	});
});
