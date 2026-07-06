/**
 * CommitQualityChecker — validates agent-authored git commits against AGENTS.md rules.
 *
 * Rules (from AGENTS.md):
 *   - Format: <type>: <desc> — one of feat/fix/refactor/test/docs/chore/ci
 *   - Subject ≤ 72 characters
 *   - No trailing period
 *   - Lowercase subject
 *   - No tracker IDs (PROJ-123, #123, TSK-...)
 *   - No bullet lists in body
 *
 * Score: fraction of commits passing all rules.
 * No commits after seed → score 0.
 */

import type { Checker, CheckerContext, CheckerResult } from "../evaluation.js";
import { getAgentCommits } from "../git-workspace.js";

const SUBJECT_FORMAT = /^(feat|fix|refactor|test|docs|chore|ci): .+/;
const TRACKER_ID = /\b[A-Z]{2,}-\d+\b|#\d+|\bTSK-\d+\b/;
const BULLET_LINE = /^\s*[-*] /m;

/**
 *
 */
export interface CommitQualityOptions {
	/** Seed SHA returned by initGitWorkspace(). Required. */
	seedSha: string;
}

/**
 *
 */
export interface CommitViolation {
	sha: string;
	rule: string;
	message: string;
}

/**
 *
 */
function checkCommit(sha: string, subject: string, body: string): CommitViolation[] {
	const violations: CommitViolation[] = [];
	// eslint-disable-next-line no-magic-numbers
	const v = (rule: string, message: string) => violations.push({ sha: sha.slice(0, 8), rule, message });

	if (!SUBJECT_FORMAT.test(subject)) {
		v("format", `Subject must match '<type>: <desc>' (feat|fix|refactor|test|docs|chore|ci). Got: "${subject}"`);
	}
	// eslint-disable-next-line no-magic-numbers
	if (subject.length > 72) {
		v("length", `Subject is ${subject.length} characters (maximum 72). Got: "${subject}"`);
	}
	if (subject.endsWith(".")) {
		v("no-period", `Subject must not end with a period. Got: "${subject}"`);
	}
	if (subject !== subject.toLowerCase()) {
		v("lowercase", `Subject must be lowercase. Got: "${subject}"`);
	}
	if (TRACKER_ID.test(subject)) {
		v("no-tracker", `Subject contains a tracker ID. Got: "${subject}"`);
	}
	if (body && BULLET_LINE.test(body)) {
		v("no-bullets", `Commit body contains bullet list items (- or *). Use prose instead.`);
	}

	return violations;
}

/**
 *
 */
export function commitQualityCheck(opts?: Partial<CommitQualityOptions>): Checker {
	return {
		// eslint-disable-next-line @typescript-eslint/require-await
		async check({ workspace, seedSha: ctxSeedSha }: CheckerContext): Promise<CheckerResult> {
			const resolvedSha = opts?.seedSha ?? ctxSeedSha;
			if (!resolvedSha) {
				return {
					pass: false,
					score: 0,
					errors: ["commitQualityCheck: seedSha is required (set seedGitRepo: true in PhaseEvaluation)."],
				};
			}
			const commits = getAgentCommits(workspace, resolvedSha);

			if (commits.length === 0) {
				return {
					pass: false,
					score: 0,
					errors: ["No commits found after the seed commit. The agent must commit its changes."],
				};
			}

			const allViolations: CommitViolation[] = [];
			for (const c of commits) {
				allViolations.push(...checkCommit(c.sha, c.subject, c.body));
			}

			const violatingCommits = new Set(allViolations.map((v) => v.sha)).size;
			const score = (commits.length - violatingCommits) / commits.length;

			const errors = allViolations.map((v) => `[${v.sha}] ${v.rule}: ${v.message}`);

			return { pass: allViolations.length === 0, score, errors };
		},
	};
}
