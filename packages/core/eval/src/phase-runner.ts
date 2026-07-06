/**
 * PhaseEvaluationRunner — executes a PhaseEvaluation against EvalHarness.
 *
 * Protocol per phase:
 *   1. Inject phase.prompt into the running agent session.
 *   2. Run phase.checker against workspace + spans + lastReply.
 *   3. If score >= threshold (default 1.0) or attempts exhausted → record PhaseResult.
 *   4. If score below threshold and retries remain → inject corrective prompt, retry.
 *   5. Decay: finalScore = rawScore × decayFactor^(attempts-1).
 *
 * All phases share a single agent session — conversation history accumulates.
 * Score aggregation: totalScore = Σ(phase.weight × finalScore).
 * Weighted, not all-or-nothing. passed = totalScore >= passThreshold.
 */

import { rm } from "node:fs/promises";
import type { Phase, PhaseEvaluation, PhaseEvaluationResult, PhaseResult } from "./evaluation.js";
import { initGitWorkspace } from "./git-workspace.js";
import type { EvalHarness, HarnessOptions } from "./harness.js";

const DEFAULT_DECAY = 0.8;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_PASS_THRESHOLD = 0.7;
const DEFAULT_PHASE_PASS_THRESHOLD = 1.0;

/**
 *
 */
function buildCorrectivePrompt(phase: Phase, violations: string[], attempt: number): string {
	const total = (phase.maxRetries ?? DEFAULT_MAX_RETRIES) + 1;
	const header = phase.retryPrompt
		? `Phase '${phase.name}' check failed (attempt ${attempt}/${total}):\n\n${phase.retryPrompt}`
		: `Phase '${phase.name}' check failed (attempt ${attempt}/${total}):`;

	return [header, "", ...violations.map((v) => `  - ${v}`), "", "Please address the issues above and try again."].join(
		"\n",
	);
}

/**
 *
 */
function computeWeights(phases: readonly Phase[]): number[] {
	const explicit = phases.filter((p) => p.weight !== undefined);
	const implicit = phases.filter((p) => p.weight === undefined);

	if (explicit.length === phases.length) {
		return phases.map((p) => p.weight ?? 0);
	}
	if (explicit.length === 0) {
		return phases.map(() => 1 / phases.length);
	}

	const explicitSum = explicit.reduce((s, p) => s + (p.weight ?? 0), 0);
	const remainder = Math.max(0, 1 - explicitSum);
	const implicitWeight = implicit.length > 0 ? remainder / implicit.length : 0;
	return phases.map((p) => p.weight ?? implicitWeight);
}

/**
 *
 */
export interface PhaseRunnerOptions extends Partial<HarnessOptions> {
	/** Extra harness options forwarded to EvalHarness.boot(). */
}

/**
 *
 */
export class PhaseEvaluationRunner {
	private readonly harness: EvalHarness;
	private readonly harnessOptions: PhaseRunnerOptions;

	constructor(harness: EvalHarness, options: PhaseRunnerOptions = {}) {
		this.harness = harness;
		this.harnessOptions = options;
	}

	async run(evaluation: PhaseEvaluation): Promise<PhaseEvaluationResult> {
		const passThreshold = evaluation.passThreshold ?? DEFAULT_PASS_THRESHOLD;

		const handle = await this.harness.boot({
			scenario: evaluation.id,
			...this.harnessOptions,
			keepWorkspace: true,
			...(evaluation.scenarioTimeoutMs !== undefined && { scenarioTimeoutMs: evaluation.scenarioTimeoutMs }),
		});

		// Seed task files.
		for (const file of evaluation.seed ?? []) {
			await handle.writeFile(file.path, file.content);
		}

		// Optionally initialise a git repo with AGENTS.md.
		const seedSha: string | undefined = evaluation.seedGitRepo ? initGitWorkspace(handle.path) : undefined;

		const weights = computeWeights(evaluation.phases);
		const results: PhaseResult[] = [];
		let aborted = false;

		for (let i = 0; i < evaluation.phases.length; i++) {
			const phase = evaluation.phases[i];
			const weight = weights[i];

			if (aborted) {
				results.push({
					name: phase.name,
					weight,
					attempts: 0,
					rawScore: 0,
					finalScore: 0,
					weightedScore: 0,
					violations: [],
					skipped: true,
				});
				continue;
			}

			const maxRetries = phase.maxRetries ?? DEFAULT_MAX_RETRIES;
			const decayFactor = phase.decayFactor ?? DEFAULT_DECAY;
			const phasePassThreshold = phase.passThreshold ?? DEFAULT_PHASE_PASS_THRESHOLD;

			let attempts = 0;
			let rawScore = 0;
			let violations: string[] = [];

			// First attempt.
			await handle.send(phase.prompt);
			attempts++;

			// Retry loop.
			for (;;) {
				const checkerResult = await phase.checker.check({
					workspace: handle.path,
					spans: handle.spans(),
					lastReply: handle.lastReply,
					...(seedSha !== undefined && { seedSha }),
				});

				rawScore = checkerResult.score;
				violations = checkerResult.errors;

				if (rawScore >= phasePassThreshold || attempts > maxRetries) break;

				// Inject corrective prompt and retry.
				await handle.send(buildCorrectivePrompt(phase, violations, attempts));
				attempts++;
			}

			const finalScore = rawScore * decayFactor ** (attempts - 1);
			const weightedScore = finalScore * weight;

			results.push({
				name: phase.name,
				weight,
				attempts,
				rawScore,
				finalScore,
				weightedScore,
				violations,
				skipped: false,
			});

			if (rawScore < phasePassThreshold && phase.onExhausted === "stop") {
				aborted = true;
			}
		}

		const totalScore = results.filter((r) => !r.skipped).reduce((s, r) => s + r.weightedScore, 0);
		const passed = totalScore >= passThreshold;
		const workspace = handle.path;

		await handle.dispose(passed);

		// Cleanup — always remove workspace.
		await rm(workspace, { recursive: true, force: true }).catch(() => {});

		return {
			id: evaluation.id,
			phases: results,
			totalScore,
			passed,
		};
	}
}

/**
 * Format a PhaseEvaluationResult as a human-readable table.
 */
export function formatPhaseReport(result: PhaseEvaluationResult): string {
	const status = result.passed ? "PASS" : "FAIL";
	const lines = [
		`[${status}] ${result.id}`,
		// eslint-disable-next-line no-magic-numbers
		`${"─".repeat(70)}`,
		// eslint-disable-next-line no-magic-numbers
		`${"Phase".padEnd(20)} ${"w".padStart(5)} ${"att".padStart(4)} ${"raw".padStart(5)} ${"final".padStart(6)} ${"weighted".padStart(8)}  status`,
		// eslint-disable-next-line no-magic-numbers
		`${"─".repeat(70)}`,
	];

	for (const r of result.phases) {
		// eslint-disable-next-line no-magic-numbers
		const st = r.skipped ? "skip" : r.finalScore >= 0.7 ? "✓" : "✗";
		lines.push(
			// eslint-disable-next-line no-magic-numbers
			`${r.name.padEnd(20)} ${r.weight.toFixed(2).padStart(5)} ${String(r.attempts).padStart(4)} ${r.rawScore.toFixed(2).padStart(5)} ${r.finalScore.toFixed(2).padStart(6)} ${r.weightedScore.toFixed(3).padStart(8)}  ${st}`,
		);
		for (const v of r.violations) {
			lines.push(`  ↳ ${v}`);
		}
	}

	// eslint-disable-next-line no-magic-numbers
	lines.push(`${"─".repeat(70)}`);
	// eslint-disable-next-line no-magic-numbers
	lines.push(`Total weighted score: ${result.totalScore.toFixed(3)}  threshold: 0.700  → ${status}`);
	return lines.join("\n");
}
