/**
 * commitQualityCheck — deterministic checker for git commit message conventions.
 * No LLM, no network. Uses a real temp git repo per test.
 */

import { afterEach, describe, expect, it } from "vitest";
import { commitQualityCheck } from "../../src/checkers/commit-quality.js";
import { commitWithMessage, ctx, makeTestRepo, useCleanup } from "../helpers/git-test-utils.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_COMMIT = "fix: correct off-by-one in sum loop";
const LONG_SUBJECT = `fix: ${"a".repeat(70)}`; // 75 chars — over the 72 limit
const MISSING_TYPE = "Fixed the bug";
const TRAILING_PERIOD = "fix: correct the bug.";
const UPPERCASE_TYPE = "Fix: correct the bug";
const WITH_TRACKER_ID = "fix: correct PROJ-123 bug";
const VALID_COMMIT_2 = "fix: valid commit";
const INVALID_COMMIT = "Fixed another bug.";

const ALL_VALID_TYPES = ["feat", "fix", "refactor", "test", "docs", "chore", "ci"] as const;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("commitQualityCheck", { tags: ["unit"] }, () => {
	useCleanup(afterEach);

	it("passes a valid conventional commit with score 1.0", async () => {
		const { workspace, seedSha } = makeTestRepo();
		commitWithMessage(workspace, VALID_COMMIT);

		const result = await commitQualityCheck({ seedSha }).check(ctx(workspace, seedSha));

		expect(result.pass).toBe(true);
		expect(result.score).toBe(1.0);
		expect(result.errors).toHaveLength(0);
	});

	it("fails with score 0 when there are no agent commits", async () => {
		const { workspace, seedSha } = makeTestRepo();

		const result = await commitQualityCheck({ seedSha }).check(ctx(workspace, seedSha));

		expect(result.score).toBe(0);
		expect(result.errors[0]).toMatch(/no commits found/i);
	});

	it("flags subject over 72 characters", async () => {
		const { workspace, seedSha } = makeTestRepo();
		commitWithMessage(workspace, LONG_SUBJECT);

		const result = await commitQualityCheck({ seedSha }).check(ctx(workspace, seedSha));

		expect(result.errors.some((e) => e.includes("length"))).toBe(true);
	});

	it("flags missing type prefix", async () => {
		const { workspace, seedSha } = makeTestRepo();
		commitWithMessage(workspace, MISSING_TYPE);

		const result = await commitQualityCheck({ seedSha }).check(ctx(workspace, seedSha));

		expect(result.errors.some((e) => e.includes("format"))).toBe(true);
	});

	it("flags trailing period in subject", async () => {
		const { workspace, seedSha } = makeTestRepo();
		commitWithMessage(workspace, TRAILING_PERIOD);

		const result = await commitQualityCheck({ seedSha }).check(ctx(workspace, seedSha));

		expect(result.errors.some((e) => e.includes("no-period"))).toBe(true);
	});

	it("flags uppercase type prefix", async () => {
		const { workspace, seedSha } = makeTestRepo();
		commitWithMessage(workspace, UPPERCASE_TYPE);

		const result = await commitQualityCheck({ seedSha }).check(ctx(workspace, seedSha));

		expect(result.errors.some((e) => e.includes("format") || e.includes("lowercase"))).toBe(true);
	});

	it("flags tracker ID in subject", async () => {
		const { workspace, seedSha } = makeTestRepo();
		commitWithMessage(workspace, WITH_TRACKER_ID);

		const result = await commitQualityCheck({ seedSha }).check(ctx(workspace, seedSha));

		expect(result.errors.some((e) => e.includes("no-tracker"))).toBe(true);
	});

	it("gives partial score when only some commits are valid", async () => {
		const { workspace, seedSha } = makeTestRepo();
		commitWithMessage(workspace, VALID_COMMIT_2);
		commitWithMessage(workspace, INVALID_COMMIT);

		const result = await commitQualityCheck({ seedSha }).check(ctx(workspace, seedSha));

		expect(result.score).toBe(0.5);
	});

	it("accepts all seven conventional commit types", async () => {
		const { workspace, seedSha } = makeTestRepo();
		for (const type of ALL_VALID_TYPES) {
			commitWithMessage(workspace, `${type}: do something`);
		}

		const result = await commitQualityCheck({ seedSha }).check(ctx(workspace, seedSha));

		expect(result.score).toBe(1.0);
	});
});
