/**
 * Regression baseline — persists per-evaluation pass/fail/score across runs.
 *
 * Usage:
 *   const baseline = await EvalBaseline.load(path)
 *   baseline.record(evaluationId, { pass, score })
 *   const regressions = baseline.regressions()  // previously passing, now failing
 *   await baseline.save(path)
 *
 * File format: JSON with one entry per evaluation ID.
 * Commit the baseline file to detect regressions in CI.
 *
 * Regression = previously score >= threshold AND now score < threshold.
 * Default threshold: 0.8 (allows minor score variation, catches hard fails).
 */

import { readFile, writeFile } from "node:fs/promises";

export interface BaselineEntry {
	pass: boolean;
	score: number;
	/** ISO timestamp of the last run that set this entry. */
	lastRun: string;
	/** Number of consecutive passes. */
	passStreak: number;
}

export interface RegressionReport {
	evaluationId: string;
	previousScore: number;
	currentScore: number;
}

export class EvalBaseline {
	private readonly entries: Map<string, BaselineEntry>;

	private constructor(entries: Map<string, BaselineEntry>) {
		this.entries = entries;
	}

	static async load(path: string): Promise<EvalBaseline> {
		try {
			const raw = await readFile(path, "utf-8");
			const obj = JSON.parse(raw) as Record<string, BaselineEntry>;
			return new EvalBaseline(new Map(Object.entries(obj)));
		} catch {
			return new EvalBaseline(new Map());
		}
	}

	static empty(): EvalBaseline {
		return new EvalBaseline(new Map());
	}

	record(evaluationId: string, result: { pass: boolean; score: number }): void {
		const existing = this.entries.get(evaluationId);
		this.entries.set(evaluationId, {
			pass: result.pass,
			score: result.score,
			lastRun: new Date().toISOString(),
			passStreak: result.pass ? (existing?.passStreak ?? 0) + 1 : 0,
		});
	}

	/**
	 * Returns evaluations that regressed since the last recorded run.
	 * A regression is: was passing (score >= threshold), now failing (score < threshold).
	 */
	regressions(newResults: Map<string, { score: number }>, threshold = 0.8): RegressionReport[] {
		const reports: RegressionReport[] = [];
		for (const [id, current] of newResults) {
			const previous = this.entries.get(id);
			if (!previous) continue; // new evaluation, no regression
			if (previous.score >= threshold && current.score < threshold) {
				reports.push({
					evaluationId: id,
					previousScore: previous.score,
					currentScore: current.score,
				});
			}
		}
		return reports;
	}

	/** All recorded entries. */
	snapshot(): Record<string, BaselineEntry> {
		return Object.fromEntries(this.entries);
	}

	async save(path: string): Promise<void> {
		await writeFile(path, JSON.stringify(this.snapshot(), null, 2), "utf-8");
	}

	get size(): number {
		return this.entries.size;
	}
}
