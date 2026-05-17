/**
 * EvaluationRunner — executes an Evaluation against the EvalHarness.
 *
 * Flow:
 *   1. Seed workspace files
 *   2. Send prompt(s) — one dialog.send() per string in multi-turn
 *   3. Check mustUse / mustNotUse against OTel spans
 *   4. Run referee against workspace + spans + last reply
 *   5. Return EvaluationResult
 *
 * MustUse failure overrides score to 0 regardless of referee result.
 *
 * fixtureCheck(): writes fixture.files to a temp dir and runs the referee.
 * Proves the referee is correct before running real evaluations. No LLM needed.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Evaluation, RefereeResult } from "./evaluation.js";
import { assertToolNotUsed, assertToolUsed, type EvalHarness } from "./harness.js";
import type { HarnessOptions, RunMetrics } from "./index.js";

export interface EvaluationResult extends RefereeResult {
	/** Full run metrics from the EvalHarness. */
	metrics: RunMetrics;
	/** MustUse violations, if any. */
	mustUseErrors: string[];
}

export class EvaluationRunner {
	private readonly harness: EvalHarness;
	private readonly harnessOptions: Partial<HarnessOptions>;

	constructor(harness: EvalHarness, options: Partial<HarnessOptions> = {}) {
		this.harness = harness;
		this.harnessOptions = options;
	}

	async run(evaluation: Evaluation): Promise<EvaluationResult> {
		let lastReply = "";
		let workspacePath = "";

		const metrics = await this.harness.run(
			async (ctx) => {
				workspacePath = ctx.workspace;

				for (const file of evaluation.seed ?? []) {
					await ctx.writeFile(file.path, file.content);
				}

				const prompts = Array.isArray(evaluation.prompt) ? evaluation.prompt : [evaluation.prompt];
				for (const p of prompts) {
					lastReply = await ctx.send(p);
				}
			},
			{
				scenario: evaluation.id,
				...this.harnessOptions,
			},
		);

		// MustUse / MustNotUse checks.
		const mustUseErrors: string[] = [];
		for (const tool of evaluation.mustUse ?? []) {
			try {
				assertToolUsed(metrics, tool);
			} catch (e) {
				mustUseErrors.push(e instanceof Error ? e.message : String(e));
			}
		}
		for (const tool of evaluation.mustNotUse ?? []) {
			try {
				assertToolNotUsed(metrics, tool);
			} catch (e) {
				mustUseErrors.push(e instanceof Error ? e.message : String(e));
			}
		}

		// Run referee.
		const refereeResult = await evaluation.referee.check({
			workspace: workspacePath,
			spans: metrics.spans,
			lastReply,
		});

		const score = mustUseErrors.length > 0 ? 0 : refereeResult.score;
		const errors = [...mustUseErrors, ...refereeResult.errors];

		return {
			pass: errors.length === 0 && metrics.passed,
			score,
			errors,
			metrics,
			mustUseErrors,
		};
	}

	/**
	 * Fixture check — run the referee against known-good files without any LLM.
	 * Throws if score < 0.9. Use in CI fixture-tests.
	 */
	static async fixtureCheck(evaluation: Evaluation): Promise<void> {
		if (!evaluation.fixture) {
			throw new Error(`Evaluation '${evaluation.id}' has no fixture`);
		}

		const workspace = join(tmpdir(), `alef-fixture-${evaluation.id}-${Date.now()}`);
		await mkdir(workspace, { recursive: true });

		try {
			for (const [path, content] of Object.entries(evaluation.fixture.files)) {
				const abs = join(workspace, path);
				await mkdir(dirname(abs), { recursive: true });
				await writeFile(abs, content, "utf-8");
			}

			const result = await evaluation.referee.check({
				workspace,
				spans: [],
				lastReply: "",
			});

			if (result.score < 0.9) {
				throw new Error(
					`Fixture check failed for '${evaluation.id}': score=${result.score}\n${result.errors.join("\n")}`,
				);
			}
		} finally {
			await rm(workspace, { recursive: true, force: true });
		}
	}
}
