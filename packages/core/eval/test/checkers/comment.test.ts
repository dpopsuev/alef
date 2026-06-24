/**
 * commentCheck — heuristic WHAT-comment detector.
 * No LLM, no network. Uses real git repos to generate genuine diffs.
 */

import { afterEach, describe, expect, it } from "vitest";
import { commentCheck } from "../../src/checkers/comment.js";
import { commitFile, ctx, makeTestRepo, useCleanup } from "../helpers/git-test-utils.js";

// ---------------------------------------------------------------------------
// TypeScript fixtures — named so failure messages are readable
// ---------------------------------------------------------------------------

const CLEAN_FUNCTION = `\
export function sum(a: number, b: number): number {
  return a + b;
}`;

const WHY_COMMENT = `\
export function retry(fn: () => void): void {
  // Reversed order because the API resolves newest-first.
  for (let i = 2; i >= 0; i--) fn();
}`;

const WHAT_COMMENT = `\
export async function getUser(id: string) {
  // Get the user from the database
  const user = await db.find(id);
  return user;
}`;

const WHAT_COMMENT_LOWERCASE = `\
export function process(items: string[]) {
  // filter empty items
  return items.filter(Boolean);
}`;

const MIXED_COMMENTS = `\
export function process(items: string[]) {
  // Skipping nulls because downstream consumers don't handle null gracefully.
  // Filter empty items
  return items.filter((x) => x !== null && x !== "");
}`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("commentCheck", { tags: ["unit"] }, () => {
	useCleanup(afterEach);

	it("passes with score 1.0 when file has no comments", async () => {
		const { workspace, seedSha } = makeTestRepo();
		commitFile(workspace, "src/clean.ts", CLEAN_FUNCTION);

		const result = await commentCheck({ seedSha }).check(ctx(workspace, seedSha));

		expect(result.score).toBe(1.0);
		expect(result.errors).toHaveLength(0);
	});

	it("passes WHY comments — explains reason, not action", async () => {
		const { workspace, seedSha } = makeTestRepo();
		commitFile(workspace, "src/why.ts", WHY_COMMENT);

		const result = await commentCheck({ seedSha }).check(ctx(workspace, seedSha));

		expect(result.score).toBe(1.0);
	});

	it("flags WHAT comment starting with an imperative verb", async () => {
		const { workspace, seedSha } = makeTestRepo();
		commitFile(workspace, "src/what.ts", WHAT_COMMENT);

		const result = await commentCheck({ seedSha }).check(ctx(workspace, seedSha));

		expect(result.score).toBeLessThan(1.0);
		expect(result.errors.some((e: string) => e.includes("WHAT"))).toBe(true);
	});

	it("flags lowercase WHAT verb", async () => {
		const { workspace, seedSha } = makeTestRepo();
		commitFile(workspace, "src/lower.ts", WHAT_COMMENT_LOWERCASE);

		const result = await commentCheck({ seedSha }).check(ctx(workspace, seedSha));

		expect(result.score).toBeLessThan(1.0);
	});

	it("passes when only non-TypeScript files changed", async () => {
		const { workspace, seedSha } = makeTestRepo();
		commitFile(workspace, "README.md", "# Updated readme\n");

		const result = await commentCheck({ seedSha }).check(ctx(workspace, seedSha));

		expect(result.score).toBe(1.0);
	});

	it("gives partial score for one WHAT among one WHY", async () => {
		const { workspace, seedSha } = makeTestRepo();
		commitFile(workspace, "src/mixed.ts", MIXED_COMMENTS);

		const result = await commentCheck({ seedSha }).check(ctx(workspace, seedSha));

		// 2 comments, 1 violation → 0 < score < 1
		expect(result.score).toBeGreaterThan(0);
		expect(result.score).toBeLessThan(1.0);
	});
});
