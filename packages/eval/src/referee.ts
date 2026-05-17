/**
 * Built-in Referees — deterministic post-run verifiers.
 *
 * All referees are pure functions. No LLM. No network.
 *
 * Graduated scoring:
 *   1.0 — full pass (file correct, keywords present, assertions met)
 *   0.5 — partial (file exists but content wrong)
 *   0.0 — hard fail (file missing, required assertion failed)
 *
 * Composing referees: AllReferee runs multiple and takes the min score.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Referee, RefereeContext, RefereeResult } from "./evaluation.js";

// ---------------------------------------------------------------------------
// FileExistsReferee — checks a file was created
// ---------------------------------------------------------------------------

export function fileExists(relativePath: string): Referee {
	return {
		async check({ workspace }: RefereeContext): Promise<RefereeResult> {
			try {
				await readFile(join(workspace, relativePath), "utf-8");
				return { pass: true, score: 0.5, errors: [] }; // exists but not content-checked
			} catch {
				return { pass: false, score: 0, errors: [`File not found: ${relativePath}`] };
			}
		},
	};
}

// ---------------------------------------------------------------------------
// FileContentReferee — checks file contains required strings
// ---------------------------------------------------------------------------

export function fileContains(relativePath: string, ...required: string[]): Referee {
	return {
		async check({ workspace }: RefereeContext): Promise<RefereeResult> {
			let content: string;
			try {
				content = await readFile(join(workspace, relativePath), "utf-8");
			} catch {
				return { pass: false, score: 0, errors: [`File not found: ${relativePath}`] };
			}

			const missing = required.filter((r) => !content.includes(r));
			if (missing.length === 0) return { pass: true, score: 1.0, errors: [] };

			// Partial: file exists but some required strings missing
			const found = required.length - missing.length;
			const score = found > 0 ? 0.5 : 0;
			return {
				pass: false,
				score,
				errors: missing.map((m) => `'${m}' not found in ${relativePath}`),
			};
		},
	};
}

// ---------------------------------------------------------------------------
// ReplyContainsReferee — checks agent reply includes keywords
// ---------------------------------------------------------------------------

export function replyContains(...required: string[]): Referee {
	return {
		check({ lastReply }: RefereeContext): RefereeResult {
			if (!lastReply) return { pass: false, score: 0, errors: ["No reply captured"] };
			const lower = lastReply.toLowerCase();
			const missing = required.filter((r) => !lower.includes(r.toLowerCase()));
			if (missing.length === 0) return { pass: true, score: 1.0, errors: [] };
			const found = required.length - missing.length;
			return {
				pass: false,
				score: found > 0 ? 0.5 : 0,
				errors: missing.map((m) => `Reply missing keyword: '${m}'`),
			};
		},
	};
}

// ---------------------------------------------------------------------------
// AllReferee — runs multiple, returns min score
// ---------------------------------------------------------------------------

export function all(...referees: Referee[]): Referee {
	return {
		async check(ctx: RefereeContext): Promise<RefereeResult> {
			const results = await Promise.all(referees.map((r) => r.check(ctx)));
			const errors = results.flatMap((r) => r.errors);
			const score = Math.min(...results.map((r) => r.score));
			return { pass: errors.length === 0, score, errors };
		},
	};
}

// ---------------------------------------------------------------------------
// AnyReferee — runs multiple, returns max score (lenient)
// ---------------------------------------------------------------------------

export function any(...referees: Referee[]): Referee {
	return {
		async check(ctx: RefereeContext): Promise<RefereeResult> {
			const results = await Promise.all(referees.map((r) => r.check(ctx)));
			const best = results.reduce((a, b) => (a.score >= b.score ? a : b));
			return best;
		},
	};
}
