/**
 * Evaluation — declarative scenario for eval.
 *
 * An Evaluation is pure data — no I/O, no assertions inline.
 * EvaluationRunner executes it. Checker checks it deterministically.
 *
 * ToolLevel — which tool surface is available to the agent:
 *   ReadOnly   — fs.read, fs.grep, fs.find, code.read, code.search
 *   ReadWrite  — ReadOnly + fs.write, fs.edit, shell.exec
 *
 * Run ReadOnly first: if the agent passes without write tools it didn't cheat.
 * Step up to ReadWrite only when the task genuinely requires mutation.
 *
 * Deferred tiers (add when prerequisites are built):
 *   Planning   — ReadWrite + PlanningAdapter
 *   Networked  — Planning + recall adapter + Router/MCP
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
	/** Command event types that MUST NOT appear in OTel spans. */
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
	/** Baseline git SHA before the agent's work (set by PhaseEvaluationRunner when seedGitRepo: true). */
	seedSha?: string;
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

// ---------------------------------------------------------------------------
// PhaseEvaluation — multi-phase evaluation with retry and weighted scoring
// ---------------------------------------------------------------------------

export interface Phase {
	/** Human-readable name — appears in PhaseResult and corrective prompts. */
	readonly name: string;
	/** Prompt injected at the start of this phase. */
	readonly prompt: string;
	/** Checker run after the agent replies. */
	readonly checker: Checker;
	/**
	 * Weight of this phase in the total score (all weights should sum to 1.0).
	 * Default: 1 / number of phases.
	 */
	readonly weight?: number;
	/** Maximum number of retry attempts after the first try. Default: 2 (3 total). */
	readonly maxRetries?: number;
	/**
	 * Score multiplier per retry: finalScore = rawScore × decayFactor^(attempts-1).
	 * Default: 0.8 (20% penalty per retry).
	 */
	readonly decayFactor?: number;
	/**
	 * Prefix prepended to the checker violations list in corrective prompts.
	 * Gives domain context beyond the raw violation strings.
	 */
	readonly retryPrompt?: string;
	/**
	 * What happens when maxRetries is exhausted and score is still below threshold.
	 *   "stop"     — abort the evaluation; remaining phases are skipped.
	 *   "continue" — record the low score and move to the next phase.
	 */
	readonly onExhausted: "stop" | "continue";
	/** Score below which the checker result is treated as a failure. Default: 1.0. */
	readonly passThreshold?: number;
}

export interface PhaseResult {
	readonly name: string;
	readonly weight: number;
	/** Number of attempts (1 = first try, 2 = one retry, …). */
	readonly attempts: number;
	/** Checker score on the final attempt, before decay is applied. */
	readonly rawScore: number;
	/** rawScore × decayFactor^(attempts-1). */
	readonly finalScore: number;
	/** finalScore × weight. */
	readonly weightedScore: number;
	/** Checker violations from the final attempt. */
	readonly violations: string[];
	/** True if this phase was never executed (prior phase used onExhausted:"stop"). */
	readonly skipped: boolean;
}

export interface PhaseEvaluationResult {
	readonly id: string;
	readonly phases: PhaseResult[];
	/** Σ(weightedScore) across non-skipped phases. */
	readonly totalScore: number;
	/** true if totalScore >= passThreshold. */
	readonly passed: boolean;
	/** Workspace path if keepWorkspace was set. */
	readonly workspace?: string;
}

// ---------------------------------------------------------------------------
// Two-score architecture: Deterministic (Score 1) + Stochastic (Score 2)
// ---------------------------------------------------------------------------

/**
 * EvalReport — the top-level result combining both scores.
 *
 * Score 1 (deterministic): phase results from PhaseEvaluationRunner.
 *   Static: commit quality, compile, lint, comment policy.
 *   Dynamic: tests pass, coverage, property invariants, mutation detection.
 *
 * Score 2 (stochastic): LLM judge panel results from JudgePanelRunner.
 *   Advisory until calibrated. Does not affect passed gate.
 *
 * Passed = Score 1 >= threshold. Score 2 is always reported alongside.
 */
export interface EvalReport {
	/** Score 1: deterministic phase results. */
	readonly phase: PhaseEvaluationResult;
	/** Score 2: stochastic LLM judge panel. Undefined when judges were not run. */
	readonly judgePanel?: import("./judge-panel-runner.js").JudgePanelResult;
}

export interface PhaseEvaluation {
	readonly id: string;
	readonly toolLevel: ToolLevel;
	readonly phases: readonly Phase[];
	/** Files to seed before phase 1. */
	readonly seed?: readonly WorkspaceFile[];
	/** If true, run git init + write AGENTS.md as initial commit before phases. */
	readonly seedGitRepo?: boolean;
	/** Total score threshold for pass. Default: 0.70. */
	readonly passThreshold?: number;
	readonly scenarioTimeoutMs?: number;
}
