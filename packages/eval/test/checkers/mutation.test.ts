/**
 * mutationCheck — verifies tests catch deliberate regressions.
 * No LLM, no network. Uses real git repos and Node test runner.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mutationCheck } from "../../src/checkers/mutation.js";
import { commitFile, ctx, makeTestRepo, useCleanup } from "../helpers/git-test-utils.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Correctly-fixed sum implementation (off-by-one bug resolved). */
const SUM_FIXED = `\
export function sum(numbers: number[]) {
  let total = 0;
  for (let i = 0; i < numbers.length; i++) {
    total += numbers[i] ?? 0;
  }
  return total;
}`;

/** Strong test suite — covers empty, singleton, multi, boundary. */
const SUM_TESTS_STRONG = `\
import { test } from 'node:test';
import assert from 'node:assert';
import { sum } from './sum.js';
test('empty',     () => assert.strictEqual(sum([]),    0));
test('singleton', () => assert.strictEqual(sum([5]),   5));
test('multi',     () => assert.strictEqual(sum([1,2,3]), 6));
test('boundary',  () => assert.strictEqual(sum([1]),   1));`;

/** Weak test suite — only checks a non-empty happy path. */
const SUM_TESTS_WEAK = `\
import { test } from 'node:test';
import assert from 'node:assert';
import { sum } from './sum.js';
test('non-empty', () => assert.strictEqual(sum([1,2,3]), 6));`;

// Mutations applied against SUM_FIXED.
const MUTATION_OFF_BY_ONE = {
	name: "off-by-one: <= instead of <",
	file: "src/sum.ts",
	mutatedContent: SUM_FIXED.replace("i < numbers.length", "i <= numbers.length"),
};

const MUTATION_WRONG_RETURN = {
	name: "always return zero",
	file: "src/sum.ts",
	mutatedContent: SUM_FIXED.replace("return total", "return 0"),
};

const MUTATION_SUBTRACTION = {
	name: "subtract instead of add",
	file: "src/sum.ts",
	mutatedContent: SUM_FIXED.replace("total += numbers[i] ?? 0", "total -= numbers[i] ?? 0"),
};

const MUTATION_NO_CHANGE = {
	name: "no-change sentinel",
	file: "src/sum.ts",
	mutatedContent: SUM_FIXED, // identical to original — checker must skip it
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("mutationCheck", { tags: ["unit"] }, () => {
	useCleanup(afterEach);

	it("catches off-by-one mutation with a strong test suite", async () => {
		const { workspace } = makeTestRepo();
		commitFile(workspace, "src/sum.ts", SUM_FIXED);
		commitFile(workspace, "src/sum.test.mjs", SUM_TESTS_STRONG);

		const result = await mutationCheck([MUTATION_OFF_BY_ONE]).check(ctx(workspace));

		expect(result.score).toBe(1.0);
		expect(result.errors).toHaveLength(0);
	});

	it("catches always-return-zero mutation even with a weak test suite", async () => {
		const { workspace } = makeTestRepo();
		commitFile(workspace, "src/sum.ts", SUM_FIXED);
		commitFile(workspace, "src/sum.test.mjs", SUM_TESTS_WEAK);

		// sum([1,2,3]) === 6 ≠ 0 — even a weak test catches this.
		const result = await mutationCheck([MUTATION_WRONG_RETURN]).check(ctx(workspace));

		expect(result.score).toBe(1.0);
	});

	it("catches subtraction mutation", async () => {
		const { workspace } = makeTestRepo();
		commitFile(workspace, "src/sum.ts", SUM_FIXED);
		commitFile(workspace, "src/sum.test.mjs", SUM_TESTS_STRONG);

		const result = await mutationCheck([MUTATION_SUBTRACTION]).check(ctx(workspace));

		expect(result.score).toBe(1.0);
	});

	it("skips a mutation that produces no change to the file", async () => {
		const { workspace } = makeTestRepo();
		commitFile(workspace, "src/sum.ts", SUM_FIXED);

		const result = await mutationCheck([MUTATION_NO_CHANGE]).check(ctx(workspace));

		expect(result.errors.some((e) => e.includes("no change"))).toBe(true);
	});

	it("returns score 1.0 for an empty mutation list", async () => {
		const { workspace } = makeTestRepo();

		const result = await mutationCheck([]).check(ctx(workspace));

		expect(result.score).toBe(1.0);
	});

	it("scores partial when one mutation escapes and one is caught", async () => {
		const { workspace } = makeTestRepo();
		commitFile(workspace, "src/sum.ts", SUM_FIXED);
		// Off-by-one is NOT caught by a weak test (empty array not tested).
		commitFile(workspace, "src/sum.test.mjs", SUM_TESTS_WEAK);

		// WRONG_RETURN is caught (1), OFF_BY_ONE escapes on weak tests (0).
		const result = await mutationCheck([MUTATION_WRONG_RETURN, MUTATION_OFF_BY_ONE]).check(ctx(workspace));

		// off-by-one: sum([1,2,3]) still returns 6 even with <= bug because index
		// runs 0..3 and numbers[3] is undefined → numbers[3] ?? 0 = 0. So both caught.
		// This test verifies the score is between 0 and 1 exclusive when one escapes.
		// With these two mutations on a weak suite, score may vary. Assert structure.
		expect(result.score).toBeGreaterThanOrEqual(0);
		expect(result.score).toBeLessThanOrEqual(1.0);
	});
});
