/**
 * End-to-end: index fixture → dependencies / references / impact via adapter tools.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BusFixture } from "@dpopsuev/alef-testkit/adapter";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCodeIntelAdapter } from "../src/adapter.js";
import { StubCodeIntelBackend } from "../src/stub-backend.js";

describe("graph tools", { tags: ["unit"] }, () => {
	let cwd: string;
	let fixture: BusFixture;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "code-intel-graph-"));
		mkdirSync(join(cwd, "src"), { recursive: true });
		writeFileSync(
			join(cwd, "src", "util.ts"),
			`export function add(a: number, b: number): number {
  return a + b;
}
`,
		);
		writeFileSync(
			join(cwd, "src", "main.ts"),
			`import { add } from "./util.js";

export function run(): number {
  return add(1, 2);
}
`,
		);
		fixture = new BusFixture();
		fixture.mount(
			createCodeIntelAdapter({
				cwd,
				backend: new StubCodeIntelBackend(),
				graphDbPath: join(cwd, "graph.db"),
			}),
		);
	});

	afterEach(() => {
		fixture.dispose();
		rmSync(cwd, { recursive: true, force: true });
	});

	it("indexes and resolves local dependencies", async () => {
		const indexResult = await fixture.call("code.index", { path: "src" });
		expect(indexResult.isError).toBe(false);
		expect((indexResult.payload as { total: number }).total).toBeGreaterThanOrEqual(2);

		const depsResult = await fixture.call("code.dependencies", { path: "src/main.ts" });
		expect(depsResult.isError).toBe(false);
		const deps = (depsResult.payload as { dependencies: Array<{ import: string; resolved: string | null }> })
			.dependencies;
		expect(deps.some((dep) => dep.import.includes("./util") && dep.resolved?.includes("util"))).toBe(true);
	});

	it("reports dependents via code.impact", async () => {
		await fixture.call("code.index", { path: "src" });
		const impactResult = await fixture.call("code.impact", { path: "src/util.ts" });
		expect(impactResult.isError).toBe(false);
		const impact = impactResult.payload as { dependents: string[] };
		expect(impact.dependents.some((path) => path.includes("main"))).toBe(true);
	});

	it("finds symbol references after index", async () => {
		await fixture.call("code.index", { path: "src" });
		const refsResult = await fixture.call("code.references", { symbol: "add", path: "src/util.ts" });
		expect(refsResult.isError).toBe(false);
		expect((refsResult.payload as { count: number }).count).toBeGreaterThan(0);
	});
});
