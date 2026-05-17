/**
 * TestReferee tests — no LLM, uses real vitest binary.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { testCheck } from "../src/referees/test.js";

const dirs: string[] = [];
function tmp(): string {
	const d = mkdtempSync(join(tmpdir(), "alef-test-ref-"));
	dirs.push(d);
	return d;
}

afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("testCheck referee", () => {
	it("passes when all tests pass", async () => {
		const ws = tmp();
		writeFileSync(join(ws, "sum.ts"), "export function sum(a: number, b: number): number { return a + b; }\n");
		writeFileSync(
			join(ws, "sum.test.ts"),
			"import { sum } from './sum';\nimport { expect, it } from 'vitest';\nit('adds', () => { expect(sum(1,2)).toBe(3); });\n",
		);

		const result = await testCheck().check({ workspace: ws, spans: [] });
		expect(result.pass).toBe(true);
		expect(result.score).toBe(1.0);
	}, 30_000);

	it("fails when tests fail", async () => {
		const ws = tmp();
		writeFileSync(
			join(ws, "buggy.ts"),
			"export function sum(a: number, b: number): number { return a - b; }  // bug\n",
		);
		writeFileSync(
			join(ws, "buggy.test.ts"),
			"import { sum } from './buggy';\nimport { expect, it } from 'vitest';\nit('adds', () => { expect(sum(1,2)).toBe(3); });\n",
		);

		const result = await testCheck().check({ workspace: ws, spans: [] });
		expect(result.pass).toBe(false);
		expect(result.score).toBeLessThan(1.0);
	}, 30_000);

	it("fixture: FixFailingTest correct sum passes tests", async () => {
		const ws = tmp();
		writeFileSync(
			join(ws, "sum.ts"),
			"export function sum(numbers: number[]): number {\n  let total = 0;\n  for (let i = 0; i < numbers.length; i++) { total += numbers[i]; }\n  return total;\n}\n",
		);
		writeFileSync(
			join(ws, "sum.test.ts"),
			"import { sum } from './sum';\nimport { expect, it } from 'vitest';\nit('sums correctly', () => { expect(sum([1,2,3])).toBe(6); expect(sum([])).toBe(0); });\n",
		);

		const result = await testCheck().check({ workspace: ws, spans: [] });
		expect(result.pass).toBe(true);
	}, 30_000);
});
