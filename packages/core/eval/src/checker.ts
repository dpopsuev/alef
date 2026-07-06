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

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Checker, CheckerContext, CheckerResult } from "./evaluation.js";

// ---------------------------------------------------------------------------
// FileExistsReferee — checks a file was created
// ---------------------------------------------------------------------------

/** Create a checker that verifies a file was created at the given path. */
export function fileExists(relativePath: string): Checker {
	return {
		async check({ workspace }: CheckerContext): Promise<CheckerResult> {
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

/** Create a checker that verifies a file contains all required strings. */
export function fileContains(relativePath: string, ...required: string[]): Checker {
	return {
		async check({ workspace }: CheckerContext): Promise<CheckerResult> {
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

/** Create a checker that verifies the agent reply includes all required keywords. */
export function replyContains(...required: string[]): Checker {
	return {
		check({ lastReply }: CheckerContext): CheckerResult {
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

/** Compose multiple checkers, returning the minimum score across all. */
export function all(...referees: Checker[]): Checker {
	return {
		async check(ctx: CheckerContext): Promise<CheckerResult> {
			const results = await Promise.all(referees.map(async (r) => r.check(ctx)));
			const errors = results.flatMap((r) => r.errors);
			const score = Math.min(...results.map((r) => r.score));
			return { pass: errors.length === 0, score, errors };
		},
	};
}

// ---------------------------------------------------------------------------
// LLMJudgeReferee — semantic quality scoring via a cheap LLM
//
// Tier 3 checker: only for capability evals where keyword matching is
// insufficient. Expensive — skip in regression evals and CI.
// Anthropic: model-based graders handle subjective quality dimensions.
//
// Requires ANTHROPIC_API_KEY. Returns score 0.0–1.0 from the judge.
// Example: llmJudge('Does the reply correctly explain the error without hallucinating?')
// ---------------------------------------------------------------------------

/** Create a checker that scores the agent reply via an LLM judge against a rubric. */
export function llmJudge(rubric: string, modelId = "claude-haiku-4-5"): Checker {
	return {
		async check({ lastReply }: CheckerContext): Promise<CheckerResult> {
			if (!lastReply) return { pass: false, score: 0, errors: ["No reply to judge"] };
			const apiKey = process.env.ANTHROPIC_API_KEY;
			if (!apiKey) {
				return { pass: false, score: 0, errors: ["ANTHROPIC_API_KEY not set — LLMJudge skipped"] };
			}

			// Direct Anthropic API call via fetch — avoids inline import (AGENTS.md).
			const prompt = `You are an evaluation judge. Score the following reply on this rubric:\n\nRUBRIC: ${rubric}\n\nREPLY:\n${lastReply}\n\nRespond with ONLY a number between 0.0 and 1.0. No other text.`;
			const res = await fetch("https://api.anthropic.com/v1/messages", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-api-key": apiKey,
					"anthropic-version": "2023-06-01",
				},
				body: JSON.stringify({
					model: modelId,
					max_tokens: 64,
					messages: [{ role: "user", content: prompt }],
				}),
			});

			if (!res.ok) {
				return { pass: false, score: 0, errors: [`LLMJudge API error: ${res.status}`] };
			}

			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Anthropic API response shape is well-known
			const json = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
			const text = json.content?.find((b) => b.type === "text")?.text ?? "";
			const score = Math.max(0, Math.min(1, parseFloat(text.trim())));
			if (Number.isNaN(score)) {
				return { pass: false, score: 0, errors: [`LLMJudge returned non-numeric: '${text}'`] };
			}
			return {
				pass: score >= 0.7,
				score,
				errors: score < 0.7 ? [`LLMJudge score ${score.toFixed(2)} < 0.7 for rubric: ${rubric}`] : [],
			};
		},
	};
}

// ---------------------------------------------------------------------------
// LintPassesReferee — runs a command in the workspace, asserts exit code 0
//
// Outcome checker: verifies what the agent DID, not what it SAID.
// Anthropic principle: the outcome is the final state in the environment.
//
// Example: lintPasses('npx', ['tsc', '--noEmit'])
//          lintPasses('npx', ['eslint', 'src/'])
// ---------------------------------------------------------------------------

/** Create a checker that runs a lint command and asserts exit code 0. */
export function lintPasses(cmd: string, args: string[] = []): Checker {
	return {
		check({ workspace }: CheckerContext): Promise<CheckerResult> {
			return new Promise((resolve) => {
				const child = spawn(cmd, args, { cwd: workspace, stdio: "pipe" });
				const stderr: string[] = [];
				child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));
				child.on("close", (code) => {
					if (code === 0) {
						resolve({ pass: true, score: 1.0, errors: [] });
					} else {
						resolve({
							pass: false,
							score: 0,
							errors: [`${cmd} exited ${code}:\n${stderr.join("").trim()}`],
						});
					}
				});
				child.on("error", (err) => {
					resolve({ pass: false, score: 0, errors: [`Failed to run ${cmd}: ${err.message}`] });
				});
			});
		},
	};
}

// ---------------------------------------------------------------------------
// AnyReferee — runs multiple, returns max score (lenient)
// ---------------------------------------------------------------------------

/** Compose multiple checkers, returning the maximum score (lenient). */
export function any(...referees: Checker[]): Checker {
	return {
		async check(ctx: CheckerContext): Promise<CheckerResult> {
			const results = await Promise.all(referees.map(async (r) => r.check(ctx)));
			const best = results.reduce((a, b) => (a.score >= b.score ? a : b));
			return best;
		},
	};
}
