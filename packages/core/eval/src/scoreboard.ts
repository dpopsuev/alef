/**
 * Scoreboard — automatic benchmark tracking for the real-LLM eval suite.
 *
 * Industry pattern (EleutherAI lm-eval-harness, W&B):
 *   - Append-only JSONL log: one line per run, committed as source of truth
 *   - Generated SCOREBOARD.md: derived from JSONL, never hand-edited
 *
 * Usage (in afterAll):
 *   const record = buildRunRecord(model, results);
 *   await appendRunRecord(BENCHMARK_PATH, record);
 *   await writeScoreboard(SCOREBOARD_PATH, await loadRunHistory(BENCHMARK_PATH));
 */

import { execSync } from "node:child_process";
import { appendFile, readFile, writeFile } from "node:fs/promises";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EvalScore {
	pass: boolean;
	score: number;
	/** Error message or timeout reason if pass=false. */
	error?: string;
	/** Wall-clock duration in ms. */
	durationMs?: number;
}

export interface RunRecord {
	/** ISO 8601 timestamp. */
	ts: string;
	/** Model identifier. */
	model: string;
	/** Provider (e.g. "anthropic-vertex"). */
	provider: string;
	/** Short git commit SHA. */
	commit: string;
	/** Number of evaluations that passed. */
	nPass: number;
	/** Total evaluations run. */
	nTotal: number;
	/** pass_rate = nPass / nTotal. */
	passRate: number;
	/** Mean score across all evaluations (0–1). */
	meanScore: number;
	/** Mean OAE across all evaluations (0–1). */
	meanOae: number;
	/** Per-evaluation results keyed by evaluation ID. */
	evals: Record<string, EvalScore>;
}

// ---------------------------------------------------------------------------
// Building a record
// ---------------------------------------------------------------------------

export function buildRunRecord(
	model: string,
	provider: string,
	results: Array<{ id: string; pass: boolean; score: number; error?: string; durationMs?: number; oae: number }>,
): RunRecord {
	const commit = gitCommitSha();
	const nPass = results.filter((r) => r.pass).length;
	const nTotal = results.length;
	const meanScore = nTotal > 0 ? results.reduce((a, r) => a + r.score, 0) / nTotal : 0;
	const meanOae = nTotal > 0 ? results.reduce((a, r) => a + r.oae, 0) / nTotal : 0;

	const evals: Record<string, EvalScore> = {};
	for (const r of results) {
		evals[r.id] = {
			pass: r.pass,
			score: r.score,
			...(r.error && { error: r.error.slice(0, 120) }),
			...(r.durationMs !== undefined && { durationMs: r.durationMs }),
		};
	}

	return {
		ts: new Date().toISOString(),
		model,
		provider,
		commit,
		nPass,
		nTotal,
		passRate: nTotal > 0 ? nPass / nTotal : 0,
		meanScore,
		meanOae,
		evals,
	};
}

// ---------------------------------------------------------------------------
// JSONL persistence
// ---------------------------------------------------------------------------

export async function appendRunRecord(benchmarkPath: string, record: RunRecord): Promise<void> {
	await appendFile(benchmarkPath, `${JSON.stringify(record)}\n`, "utf-8");
}

export async function loadRunHistory(benchmarkPath: string): Promise<RunRecord[]> {
	try {
		const raw = await readFile(benchmarkPath, "utf-8");
		return raw
			.split("\n")
			.filter((l) => l.trim())
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- JSONL lines are RunRecord objects
			.map((l) => JSON.parse(l) as RunRecord);
	} catch {
		return [];
	}
}

// ---------------------------------------------------------------------------
// Scoreboard generation
// ---------------------------------------------------------------------------

export async function writeScoreboard(scoreboardPath: string, history: RunRecord[]): Promise<void> {
	const md = generateScoreboard(history);
	await writeFile(scoreboardPath, md, "utf-8");
}

export function generateScoreboard(history: RunRecord[]): string {
	const lines: string[] = [
		"# Eval Scoreboard",
		"",
		"Auto-generated from `benchmark.jsonl`. Do not edit manually — re-runs update this file.",
		"",
	];

	if (history.length === 0) {
		lines.push("_No runs recorded yet._");
		return lines.join("\n");
	}

	// Run history table — most recent first
	lines.push("## Run History", "");
	lines.push("| Date | Commit | Model | Pass | Score | OAE |");
	lines.push("|---|---|---|---|---|---|");

	for (const r of [...history].reverse()) {
		const date = r.ts.slice(0, 10);
		const pct = (r.passRate * 100).toFixed(0);
		const score = (r.meanScore * 100).toFixed(0);
		const oae = (r.meanOae * 100).toFixed(1);
		lines.push(
			`| ${date} | \`${r.commit}\` | ${r.model} | **${r.nPass}/${r.nTotal}** (${pct}%) | ${score}% | ${oae}% |`,
		);
	}

	// Per-evaluation breakdown — latest run + trend vs previous
	const latest = history[history.length - 1];
	const prev = history.length >= 2 ? history[history.length - 2] : undefined;

	const evalIds = Object.keys(latest.evals);

	lines.push("", "## Per-Evaluation (latest run)", "");
	lines.push("| Evaluation | Status | Score | Trend | Notes |");
	lines.push("|---|---|---|---|---|");

	for (const id of evalIds) {
		const e = latest.evals[id];
		const icon = e.pass ? "✓" : "✗";
		const score = `${(e.score * 100).toFixed(0)}%`;

		// Trend vs previous run
		let trend = "—";
		if (prev?.evals[id]) {
			const prevE = prev.evals[id];
			if (!prevE.pass && e.pass) trend = "↑ improved";
			else if (prevE.pass && !e.pass) trend = "↓ regressed";
			else if (prevE.score < e.score - 0.05) trend = "↑";
			else if (prevE.score > e.score + 0.05) trend = "↓";
			else trend = "→";
		}

		const note = e.error ? e.error.slice(0, 80) : "";
		lines.push(`| ${id} | ${icon} | ${score} | ${trend} | ${note} |`);
	}

	// Aggregate stats
	lines.push("", "## Aggregate Stats (all runs)", "");
	lines.push("| Evaluation | Runs | Pass Rate | Best Score | Latest |");
	lines.push("|---|---|---|---|---|");

	for (const id of evalIds) {
		const allRuns = history.filter((r) => id in r.evals);
		const passCount = allRuns.filter((r) => r.evals[id].pass).length;
		const passRate = allRuns.length > 0 ? `${((passCount / allRuns.length) * 100).toFixed(0)}%` : "—";
		const bestScore = Math.max(...allRuns.map((r) => r.evals[id].score));
		const latestScore = latest.evals[id].score;
		lines.push(
			`| ${id} | ${allRuns.length} | ${passRate} | ${(bestScore * 100).toFixed(0)}% | ${(latestScore * 100).toFixed(0)}% |`,
		);
	}

	const updatedAt = `${latest.ts.slice(0, 10)} ${latest.ts.slice(11, 19)} UTC`;
	lines.push("", `_Last updated: ${updatedAt}_`);
	return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function gitCommitSha(): string {
	try {
		return execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
	} catch {
		return "unknown";
	}
}
