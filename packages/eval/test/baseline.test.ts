import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EvalBaseline } from "../src/baseline.js";

const dirs: string[] = [];
function tmp(): string {
	const d = mkdtempSync(join(tmpdir(), "alef-baseline-"));
	dirs.push(d);
	return d;
}

afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("EvalBaseline", () => {
	it("starts empty", () => {
		expect(EvalBaseline.empty().size).toBe(0);
	});

	it("records entries", () => {
		const b = EvalBaseline.empty();
		b.record("PlanRefactoring", { pass: true, score: 1.0 });
		expect(b.size).toBe(1);
		expect(b.snapshot()["PlanRefactoring"].pass).toBe(true);
	});

	it("increments passStreak on consecutive passes", () => {
		const b = EvalBaseline.empty();
		b.record("A", { pass: true, score: 1.0 });
		b.record("A", { pass: true, score: 1.0 });
		expect(b.snapshot()["A"].passStreak).toBe(2);
	});

	it("resets passStreak on failure", () => {
		const b = EvalBaseline.empty();
		b.record("A", { pass: true, score: 1.0 });
		b.record("A", { pass: false, score: 0 });
		expect(b.snapshot()["A"].passStreak).toBe(0);
	});

	it("round-trips through save + load", async () => {
		const dir = tmp();
		const path = join(dir, "baseline.json");
		const b = EvalBaseline.empty();
		b.record("CreateHTTPServer", { pass: true, score: 1.0 });
		await b.save(path);

		const b2 = await EvalBaseline.load(path);
		expect(b2.size).toBe(1);
		expect(b2.snapshot()["CreateHTTPServer"].score).toBe(1.0);
	});

	it("returns empty array when no baseline file exists", async () => {
		const b = await EvalBaseline.load("/nonexistent/path/baseline.json");
		expect(b.size).toBe(0);
	});

	it("detects regressions — was passing, now failing", () => {
		const b = EvalBaseline.empty();
		b.record("CreateHTTPServer", { pass: true, score: 1.0 });

		const newResults = new Map([["CreateHTTPServer", { score: 0.2 }]]);
		const regressions = b.regressions(newResults, 0.8);

		expect(regressions).toHaveLength(1);
		expect(regressions[0].evaluationId).toBe("CreateHTTPServer");
		expect(regressions[0].previousScore).toBe(1.0);
		expect(regressions[0].currentScore).toBe(0.2);
	});

	it("no regression for new evaluations with no prior record", () => {
		const b = EvalBaseline.empty();
		const newResults = new Map([["NewEval", { score: 0 }]]);
		expect(b.regressions(newResults)).toHaveLength(0);
	});

	it("no regression when score stays above threshold", () => {
		const b = EvalBaseline.empty();
		b.record("A", { pass: true, score: 0.9 });
		const newResults = new Map([["A", { score: 0.85 }]]);
		expect(b.regressions(newResults, 0.8)).toHaveLength(0);
	});
});
