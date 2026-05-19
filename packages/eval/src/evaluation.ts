/**
 * Evaluation — declarative scenario for eval.
 *
 * An Evaluation is pure data — no I/O, no assertions inline.
 * EvaluationRunner executes it. Checker checks it deterministically.
 *
 * ToolLevel — which tool surface is available to the agent:
 *   ReadOnly   — fs.read, fs.grep, fs.find, lector.read, lector.search
 *   ReadWrite  — ReadOnly + fs.write, fs.edit, shell.exec
 *
 * Run ReadOnly first: if the agent passes without write tools it didn't cheat.
 * Step up to ReadWrite only when the task genuinely requires mutation.
 *
 * Deferred tiers (add when prerequisites are built):
 *   Planning   — ReadWrite + PlanningOrgan
 *   Networked  — Planning + organ-recall + Router/MCP
 *
 * Graduated score from Checker.check():
 *   0.0 — hard fail (missing file, broken assertion)
 *   0.5 — partial (file exists but content wrong)
 *   1.0 — full pass
 *
 * mustUse/mustNotUse: tool event types that MUST/MUST NOT appear in OTel spans.
 * MustUse failure overrides score to 0 regardless of checker result.
 *
 * fixture: a known-good implementation. Checker must score >= 0.9 on it.
 *          Runs in CI without any LLM — proves the checker is correct.
 */

import type { WorkspaceFile } from "./harness.js";

export type ToolLevel = "ReadOnly" | "ReadWrite";
export type Template = "ReadOnly" | "Write" | "MultiTurn";

export interface Evaluation {
	/** Unique identifier — used in metrics and test names. */
	readonly id: string;
	/** Tool surface available during this evaluation. */
	readonly toolLevel: ToolLevel;
	/** Template category. */
	readonly template: Template;
	/**
	 * Prompt(s) to send. string = single-turn. string[] = multi-turn conversation.
	 * Each string is sent as a separate dialog.send() call.
	 */
	readonly prompt: string | readonly string[];
	/** Files to write into the workspace before running. */
	readonly seed?: readonly WorkspaceFile[];
	/** Motor event types that MUST appear in OTel spans. MustUse fail → score=0. */
	readonly mustUse?: readonly string[];
	/** Motor event types that MUST NOT appear in OTel spans. */
	readonly mustNotUse?: readonly string[];
	/** Deterministic post-run verifier. */
	readonly checker: Checker;
	/**
	 * Known-good files for checker self-test (no LLM).
	 * EvaluationRunner.fixtureCheck() writes these and runs the checker.
	 */
	readonly fixture?: FixtureSet;
}

// ---------------------------------------------------------------------------
// Checker
// ---------------------------------------------------------------------------

export interface CheckerResult {
	pass: boolean;
	/** Graduated score 0–1. */
	score: number;
	/** Human-readable failure descriptions. */
	errors: string[];
}

export interface CheckerContext {
	/** Absolute path to the workspace directory. */
	workspace: string;
	/** OTel spans from the run. */
	spans: import("./metrics.js").SpanRecord[];
	/** Agent's last reply text (if available). */
	lastReply?: string;
}

export interface Checker {
	check(ctx: CheckerContext): CheckerResult | Promise<CheckerResult>;
}

// ---------------------------------------------------------------------------
// FixtureSet
// ---------------------------------------------------------------------------

export interface FixtureSet {
	/** Files to write for the fixture test (relative path → content). */
	files: Record<string, string>;
}
