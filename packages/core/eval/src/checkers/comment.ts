/**
 * CommentChecker — heuristic detector for WHAT comments (vs WHY).
 *
 * AGENTS.md rule: "Zero comments by default. One line only when the WHY is
 * non-obvious. Never explain what the code does."
 *
 * Heuristic: ban single-line // comments where the first word is a common
 * imperative verb that describes the subsequent code's action rather than
 * the reason for it. Checks only lines added/changed by the agent
 * (via git diff) so seed file comments are never penalised.
 *
 * Score: (total_comments - violations) / total_comments.
 * No comments → 1.0 (silence is correct per the rules).
 *
 * LLM judge slot: replace the heuristic with an LLM call once calibrated.
 */

import type { Checker, CheckerContext, CheckerResult } from "../evaluation.js";
import { getAgentDiff } from "../git-workspace.js";

// Verbs that typically introduce WHAT comments (describing the code's action).
// Each must be followed by a space to avoid flagging words like "Returns" in
// doc-comment positions or "Getter" in variable names.
const WHAT_VERBS = new Set([
	"Get",
	"Set",
	"Return",
	"Returns",
	"Check",
	"Checks",
	"Loop",
	"Loops",
	"Call",
	"Calls",
	"Create",
	"Creates",
	"Update",
	"Updates",
	"Delete",
	"Deletes",
	"Handle",
	"Handles",
	"Build",
	"Builds",
	"Parse",
	"Parses",
	"Convert",
	"Converts",
	"Find",
	"Finds",
	"Filter",
	"Filters",
	"Map",
	"Maps",
	"Initialize",
	"Initializes",
	"Register",
	"Registers",
	"Process",
	"Processes",
	"Fetch",
	"Fetches",
	"Iterate",
	"Iterates",
	"Sort",
	"Sorts",
	"Add",
	"Adds",
	"Remove",
	"Removes",
	"Send",
	"Sends",
	"Receive",
	"Receives",
	"Read",
	"Reads",
	"Write",
	"Writes",
	"Log",
	"Logs",
	"Print",
	"Prints",
	"Calculate",
	"Calculates",
	"Compute",
	"Computes",
	"Throw",
	"Throws",
	"Catch",
	"Import",
	"Imports",
	"Export",
	"Exports",
]);

interface CommentViolation {
	file: string;
	line: number;
	text: string;
	reason: string;
}

function isWhatComment(commentText: string): boolean {
	// Strip the // prefix and trim.
	const body = commentText.replace(/^\/\/\s*/, "").trim();
	if (!body) return false;

	// Extract the first word.
	const firstWord = body.split(/\s+/)[0] ?? "";

	// Exact match against WHAT_VERBS (case-sensitive to match initial cap).
	if (WHAT_VERBS.has(firstWord)) return true;

	// Also flag lowercase variants of the same verbs (e.g. "// get the user").
	const capitalised = firstWord[0]?.toUpperCase() + firstWord.slice(1);
	if (WHAT_VERBS.has(capitalised)) return true;

	return false;
}

export interface CommentCheckOptions {
	/** Seed SHA returned by initGitWorkspace(). Uses ctx.seedSha from PhaseEvaluationRunner when omitted. */
	seedSha?: string;
	/** File glob passed to git diff. Default: "*.ts". */
	fileGlob?: string;
}

export function commentCheck(opts?: Partial<CommentCheckOptions>): Checker {
	return {
		check({ workspace, seedSha: ctxSeedSha }: CheckerContext): CheckerResult {
			const resolvedSha = opts?.seedSha ?? ctxSeedSha;
			if (!resolvedSha) {
				return {
					pass: false,
					score: 0,
					errors: ["commentCheck: seedSha is required (set seedGitRepo: true in PhaseEvaluation)."],
				};
			}
			const diff = getAgentDiff(workspace, resolvedSha, opts?.fileGlob ?? "*.ts");
			if (!diff) return { pass: true, score: 1.0, errors: [] };

			const violations: CommentViolation[] = [];
			let totalComments = 0;

			let currentFile = "";
			let lineNumber = 0;

			for (const raw of diff.split("\n")) {
				// Track current file from diff header.
				if (raw.startsWith("diff --git ")) {
					const m = raw.match(/b\/(.+)$/);
					currentFile = m ? (m[1] ?? "") : "";
					lineNumber = 0;
					continue;
				}
				if (raw.startsWith("@@")) {
					// @@ -oldStart,oldLen +newStart,newLen @@
					const m = raw.match(/@@ -\d+(?:,\d+)? \+(\d+)/);
					lineNumber = m ? Number(m[1]) - 1 : lineNumber;
					continue;
				}
				// Only examine added lines.
				if (!raw.startsWith("+") || raw.startsWith("+++")) continue;

				lineNumber++;
				const codeLine = raw.slice(1); // strip leading +

				// Find // comments (not inside strings — good enough for heuristic).
				const commentIdx = codeLine.indexOf("//");
				if (commentIdx === -1) continue;

				// Skip commented-out code blocks (lines that are entirely commented).
				const beforeComment = codeLine.slice(0, commentIdx).trim();
				const isLineComment = beforeComment === "";
				const isInlineComment = !isLineComment;

				const commentText = codeLine.slice(commentIdx);
				totalComments++;

				if (isWhatComment(commentText)) {
					violations.push({
						file: currentFile,
						line: lineNumber,
						text: commentText.trim(),
						reason: isInlineComment ? "inline WHAT comment" : "WHAT comment",
					});
				}
			}

			if (totalComments === 0) return { pass: true, score: 1.0, errors: [] };

			const score = (totalComments - violations.length) / totalComments;
			const errors = violations.map(
				(v) => `${v.file}:${v.line}: "${v.text}" — ${v.reason} (explains WHAT, not WHY)`,
			);

			return { pass: violations.length === 0, score, errors };
		},
	};
}
