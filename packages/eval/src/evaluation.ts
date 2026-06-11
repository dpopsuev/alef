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

/**
 * EvalKind controls how an evaluation is executed.
 *
 * CAPABILITY — exploratory, variance matters:
 *   - temperature: model default
 *   - n: 5 trials (configurable via ALEF_EVAL_N)
 *   - reports pass@k distribution + variance
 *
 * REGRESSION — protective, determinism matters:
 *   - temperature: 0
 *   - n: 1 trial
 *   - fast CI gate, catches breakage not capability limits
 */
export type EvalKind = "capability" | "regression";

/**
 * A single expected tool interaction.
 *
 * Call  — which tool was invoked (OR semantics across the array).
 * Target — what the tool was called on (matched against the tool's input args).
 * Result — what the tool must have produced (matched against the tool's output).
 *
 * All non-undefined fields must match for the expectation to be satisfied.
 */
export interface ToolCall {
	/** Acceptable tool name(s) — any one satisfies the call dimension. */
	tool: string | readonly string[];
	/** Fields that must appear in the tool's input payload. */
	target?: {
		/** File path the tool operated on (substring or regex). */
		path?: string | RegExp;
		/** Search pattern used (substring or regex). */
		pattern?: string | RegExp;
		/** Symbol name targeted (substring or regex). */
		symbol?: string | RegExp;
		/** URL fetched (substring or regex). */
		url?: string | RegExp;
		/** Arbitrary payload field — key/value or regex. */
		[key: string]: string | RegExp | undefined;
	};
	/** What the tool's output must contain (substring or regex). */
	produces?: string | RegExp;
}

export interface Evaluation {
	/** Unique identifier — used in metrics and test names. */
	readonly id: string;
	/** Tool surface available during this evaluation. */
	readonly toolLevel: ToolLevel;
	/** Template category. */
	readonly template: Template;
	/**
	 * Execution kind. Defaults to 'regression' (n=1, temperature=0).
	 * Use 'capability' for exploratory evals that need pass@k distribution.
	 */
	readonly kind?: EvalKind;
	/**
	 * Prompt(s) to send. string = single-turn. string[] = multi-turn conversation.
	 * Each string is sent as a separate dialog.send() call.
	 */
	readonly prompt: string | readonly string[];
	/** Files to write into the workspace before running. */
	readonly seed?: readonly WorkspaceFile[];
	/**
	 * ALL of these tool interactions must have occurred (AND semantics).
	 * Each entry matches call + target + result dimensions against OTel spans.
	 * Failure → score=0.
	 */
	readonly expects?: readonly ToolCall[];
	/**
	 * AT LEAST ONE of these tool interactions must have occurred (OR semantics).
	 * Useful when the agent may satisfy a requirement with any of several tools.
	 * Failure → score=0.
	 */
	readonly expectsAny?: readonly ToolCall[];
	/** Motor event types that MUST NOT appear in OTel spans. */
	readonly mustNotUse?: readonly string[];
	/** Deterministic post-run verifier. */
	readonly checker: Checker;
	/**
	 * Known-good files for checker self-test (no LLM).
	 * EvaluationRunner.fixtureCheck() writes these and runs the checker.
	 */
	readonly fixture?: FixtureSet;
	/**
	 * Per-scenario timeout in ms. Overrides HarnessOptions.scenarioTimeoutMs.
	 * Use for multi-turn evaluations that need more time than single-turn.
	 * Default: inherits scenarioTimeoutMs from HarnessOptions (180_000).
	 */
	readonly scenarioTimeoutMs?: number;
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
