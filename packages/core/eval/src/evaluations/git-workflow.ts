/**
 * Git workflow evaluations — PhaseEvaluation suite.
 *
 * Tests the agent's ability to fix a bug AND follow project conventions:
 *   - Commit message format (AGENTS.md rules)
 *   - No WHAT comments
 *   - AGENTS.md present and non-trivial
 *
 * The workspace is a real git repo seeded with a known-good AGENTS.md.
 * The agent is expected to read it and follow it without being told.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { agentsMdCheck } from "../checkers/agents-md.js";
import { commentCheck } from "../checkers/comment.js";
import { commitQualityCheck } from "../checkers/commit-quality.js";
import { compileCheck } from "../checkers/compile.js";
import { lintCheck } from "../checkers/lint.js";
import { mutationCheck, sumMutations } from "../checkers/mutation.js";
import { propertyCheck, SUM_PROPERTIES } from "../checkers/property.js";
import { testCheck } from "../checkers/test.js";
import type { Checker, CheckerContext, CheckerResult, PhaseEvaluation } from "../evaluation.js";
import type { JudgeSpec } from "../judge-panel-runner.js";

// ---------------------------------------------------------------------------
// Seed content
// ---------------------------------------------------------------------------

const BUGGY_SUM = `
export function sum(numbers: number[]): number {
  let total = 0;
  for (let i = 0; i <= numbers.length; i++) {  // bug: <= should be <
    total += numbers[i] ?? 0;
  }
  return total;
}
`.trim();

const SUM_TEST = `
import { sum } from "./sum.js";
import { expect, it } from "vitest";

it("sums positive numbers", () => {
  expect(sum([1, 2, 3])).toBe(6);
});

it("handles empty array", () => {
  expect(sum([])).toBe(0);
});

it("handles single element", () => {
  expect(sum([42])).toBe(42);
});
`.trim();

// seedSha flows through CheckerContext — PhaseEvaluationRunner sets ctx.seedSha
// from initGitWorkspace when seedGitRepo: true. Checkers read it from context.

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/**
 * Fix a known off-by-one bug and commit the fix following AGENTS.md conventions.
 *
 * Five phases:
 *   1. diagnose  — read the code, state the root cause
 *   2. fix       — edit the file, run tests
 *   3. commit    — commit with a valid message
 *   4. verify    — confirm tests still pass
 *   5. self-audit — check for WHAT comments
 */
export const fixBugWithCleanCommit: PhaseEvaluation = {
	id: "git-workflow/fix-bug-commit",
	toolLevel: "ReadWrite",
	seedGitRepo: true,
	seed: [
		{ path: "src/sum.ts", content: BUGGY_SUM },
		{ path: "src/sum.test.ts", content: SUM_TEST },
	],
	passThreshold: 0.7,
	scenarioTimeoutMs: 300_000,
	phases: [
		{
			name: "diagnose",
			prompt:
				"There is a failing test in this repository. Read the source files and the test, identify the root cause of the failure, and describe it clearly.",
			checker: {
				check({ lastReply }: CheckerContext): CheckerResult {
					const pattern = /off.by.one|index.*<=|<= .*(length|len)|loop.*one.*extra/i;
					const pass = pattern.test(lastReply ?? "");
					return {
						pass,
						score: pass ? 1.0 : 0,
						errors: pass ? [] : ["Reply does not identify the off-by-one root cause."],
					};
				},
			} satisfies Checker,
			weight: 0.1,
			maxRetries: 2,
			decayFactor: 0.8,
			onExhausted: "stop",
			retryPrompt: "Your diagnosis did not clearly identify the root cause. Re-read the code and try again.",
		},
		{
			name: "fix",
			prompt: "Fix the root cause you identified. Run the tests to confirm they pass.",
			checker: {
				check: async (ctx) => {
					// Static: type check
					const compile = await compileCheck().check(ctx);
					if (!compile.pass) return compile;
					// Dynamic: tests pass
					const tests = await testCheck().check(ctx);
					if (!tests.pass) return tests;
					// Dynamic: property invariants hold on random inputs
					const props = await propertyCheck(SUM_PROPERTIES).check(ctx);
					if (!props.pass) return props;
					return { pass: true, score: 1.0, errors: [] };
				},
			},
			weight: 0.35,
			maxRetries: 2,
			decayFactor: 0.7,
			onExhausted: "stop",
			retryPrompt: "The fix did not make the tests or property checks pass. Review the output and try again.",
		},
		{
			name: "commit",
			// AGENTS.md is the open spec (agents.md / LF) — agents discover and read it
			// automatically. No explicit mention here; the checker validates the result.
			prompt: "Commit your fix with an appropriate commit message.",
			checker: {
				check: async (ctx) => {
					// Static: commit message quality
					const commit = await commitQualityCheck().check(ctx);
					if (!commit.pass) return commit;
					// Static: lint on changed files
					return lintCheck().check(ctx);
				},
			},
			weight: 0.2,
			maxRetries: 3,
			decayFactor: 0.8,
			onExhausted: "continue",
			retryPrompt:
				"Your commit message or code quality violated project conventions. Check AGENTS.md and amend the commit:",
		},
		{
			name: "verify",
			// Dynamic: mutation testing — proves tests catch the specific bug that was fixed.
			prompt: "Run the tests one more time to confirm nothing regressed.",
			checker: {
				check: async (ctx) => {
					// Standard test pass
					const tests = await testCheck().check(ctx);
					if (!tests.pass) return tests;
					// Mutation check: tests must catch deliberate re-introduction of the bug.
					// sumMutations reads the current file content, so it reflects the agent's fix.
					try {
						const mutations = sumMutations(ctx.workspace);
						if (mutations.length > 0) {
							return mutationCheck(mutations).check(ctx);
						}
					} catch {
						// File might not exist yet — skip mutation check silently.
					}
					return tests;
				},
			},
			weight: 0.2,
			maxRetries: 1,
			decayFactor: 0.9,
			onExhausted: "continue",
		},
		{
			name: "self-audit",
			// Comment policy is in AGENTS.md — agent should have read it at startup.
			prompt: "Review your changes for any comments that describe what the code does rather than why.",
			checker: commentCheck(),
			weight: 0.1,
			maxRetries: 2,
			decayFactor: 0.9,
			onExhausted: "continue",
			retryPrompt: "Some comments still describe WHAT the code does. Remove or rewrite them to explain WHY:",
		},
	],
};

// ---------------------------------------------------------------------------
// Judge panel specs — one per specialist, loaded from SKILL.md files.
// The JudgePanelRunner seeds these into the workspace before booting each judge.
// ---------------------------------------------------------------------------

/**
 *
 */
function readSkill(name: string): string {
	const path = join(new URL("../judge-skills", import.meta.url).pathname, name, "SKILL.md");
	try {
		return readFileSync(path, "utf-8");
	} catch {
		return `# ${name}\nReview the code change and call report.submit.`;
	}
}

export const GIT_WORKFLOW_JUDGES: JudgeSpec[] = [
	{
		name: "judge-architect",
		skillMd: readSkill("architect"),
		weight: 0.25,
		prompt:
			"You are an Architect judge. The workspace contains a bug fix that was committed. " +
			"Review the change for SOLID violations, dependency direction, and abstraction quality. " +
			"Run git diff HEAD~1 to see what changed. Then call report.submit.",
	},
	{
		name: "judge-quality",
		skillMd: readSkill("quality"),
		weight: 0.2,
		prompt:
			"You are a Quality judge. Review the change for code smells, test quality, and scope discipline. " +
			"Run git diff HEAD~1 and read the test files. Then call report.submit.",
	},
	{
		name: "judge-security",
		skillMd: readSkill("security"),
		weight: 0.2,
		prompt:
			"You are a Security judge. Review the change for trust boundary violations, injection surfaces, " +
			"and STRIDE threats. Run git diff HEAD~1. Then call report.submit.",
	},
	{
		name: "judge-language",
		skillMd: readSkill("language"),
		weight: 0.15,
		prompt:
			"You are a Language judge for TypeScript. Review the change for type safety, idiomatic patterns, " +
			"and async discipline. Run git diff HEAD~1 and optionally npx tsc --noEmit. Then call report.submit.",
	},
	{
		name: "judge-performance",
		skillMd: readSkill("performance"),
		weight: 0.1,
		prompt:
			"You are a Performance judge. Review the change for algorithmic complexity and allocation issues. " +
			"Run git diff HEAD~1. Then call report.submit.",
	},
	{
		name: "judge-reviewer",
		skillMd: readSkill("reviewer"),
		weight: 0.1,
		prompt:
			"You are the Reviewer — the human proxy. Would you approve this PR? " +
			"Run git log HEAD~1 --oneline, git diff HEAD~1, read AGENTS.md. Give your verdict. Then call report.submit.",
	},
];

/**
 * AGENTS.md must be present and non-trivial after the agent works in the repo.
 * Standalone checker — combine with other phases as needed.
 */
export const agentsMdPresent: PhaseEvaluation = {
	id: "git-workflow/agents-md-present",
	toolLevel: "ReadOnly",
	seedGitRepo: true,
	seed: [],
	passThreshold: 0.7,
	phases: [
		{
			name: "check-agents-md",
			prompt: "Describe the project setup: what commands do I run to install, test, and check the code?",
			checker: agentsMdCheck(),
			weight: 1.0,
			maxRetries: 0,
			decayFactor: 1.0,
			onExhausted: "stop",
		},
	],
};
