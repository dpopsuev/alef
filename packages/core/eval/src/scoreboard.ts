/**
 * Scoreboard — automatic benchmark tracking for coding ∪ plant ∪ cost/latency.
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
import { PLANT_METRIC_KEYS } from "./consumer/plant-metrics.js";
import type { ConsumerEvalResult, ConsumerKind } from "./consumer/types.js";
import { CODING_USAGE_METRIC_KEYS } from "./metrics.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 *
 */
export interface EvalScore {
	pass: boolean;
	score: number;
	/** Error message or timeout reason if pass=false. */
	error?: string;
	/** Wall-clock duration in ms. */
	durationMs?: number;
	/** Estimated USD cost for this evaluation (when known). */
	costUsd?: number;
	/** Consumer/plant kind when not a classic coding ToolUse_* row. */
	kind?: ConsumerKind;
	/** Formal plant / intensity metric vector (subset may be present). */
	metrics?: Record<string, number | null>;
}

/**
 *
 */
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
	/** Mean OAE across all evaluations (0–1). Coding-only; 0 when absent. */
	meanOae: number;
	/** Mean wall-clock duration across evaluations with durationMs. */
	meanDurationMs?: number;
	/** Mean USD cost across evaluations with costUsd. */
	meanCostUsd?: number;
	/** Dominant kind for this run (coding | plant | mixed). */
	kind?: ConsumerKind | "mixed";
	/** Per-evaluation results keyed by evaluation ID. */
	evals: Record<string, EvalScore>;
}

// ---------------------------------------------------------------------------
// Building a record
// ---------------------------------------------------------------------------

/**
 *
 */
export function buildRunRecord(
	model: string,
	provider: string,
	results: Array<{
		id: string;
		pass: boolean;
		score: number;
		error?: string;
		durationMs?: number;
		costUsd?: number;
		oae?: number;
		kind?: ConsumerKind;
		metrics?: Record<string, number | null>;
	}>,
): RunRecord {
	const commit = gitCommitSha();
	const nPass = results.filter((r) => r.pass).length;
	const nTotal = results.length;
	const meanScore = nTotal > 0 ? results.reduce((a, r) => a + r.score, 0) / nTotal : 0;
	const oaeValues = results.map((r) => r.oae).filter((v): v is number => typeof v === "number");
	const meanOae = oaeValues.length > 0 ? oaeValues.reduce((a, b) => a + b, 0) / oaeValues.length : 0;

	const durations = results
		.map((r) => r.durationMs)
		.filter((v): v is number => typeof v === "number");
	const costs = results.map((r) => r.costUsd).filter((v): v is number => typeof v === "number");

	const kinds = new Set(results.map((r) => r.kind).filter((k): k is ConsumerKind => k !== undefined));
	let kind: RunRecord["kind"];
	if (kinds.size === 1) kind = [...kinds][0];
	else if (kinds.size > 1) kind = "mixed";

	const evals: Record<string, EvalScore> = {};
	for (const r of results) {
		evals[r.id] = {
			pass: r.pass,
			score: r.score,
			// eslint-disable-next-line no-magic-numbers
			...(r.error && { error: r.error.slice(0, 120) }),
			...(r.durationMs !== undefined && { durationMs: r.durationMs }),
			...(r.costUsd !== undefined && { costUsd: r.costUsd }),
			...(r.kind && { kind: r.kind }),
			...(r.metrics && { metrics: r.metrics }),
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
		...(durations.length > 0 && {
			meanDurationMs: durations.reduce((a, b) => a + b, 0) / durations.length,
		}),
		...(costs.length > 0 && {
			meanCostUsd: costs.reduce((a, b) => a + b, 0) / costs.length,
		}),
		...(kind && { kind }),
		evals,
	};
}

/** Build a RunRecord from consumer/plant eval results (scripted or live). */
export function buildConsumerRunRecord(
	model: string,
	provider: string,
	results: readonly ConsumerEvalResult[],
): RunRecord {
	return buildRunRecord(
		model,
		provider,
		results.map((r) => ({
			id: r.id,
			pass: r.pass,
			score: r.score,
			error: r.error,
			durationMs: r.durationMs,
			costUsd: r.costUsd,
			kind: r.kind,
			metrics: { ...r.metrics },
		})),
	);
}

// ---------------------------------------------------------------------------
// JSONL persistence
// ---------------------------------------------------------------------------

/**
 *
 */
export async function appendRunRecord(benchmarkPath: string, record: RunRecord): Promise<void> {
	await appendFile(benchmarkPath, `${JSON.stringify(record)}\n`, "utf-8");
}

/**
 *
 */
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

/**
 *
 */
export async function writeScoreboard(scoreboardPath: string, history: RunRecord[]): Promise<void> {
	const md = generateScoreboard(history);
	await writeFile(scoreboardPath, md, "utf-8");
}

/**
 *
 */
export function generateScoreboard(history: RunRecord[]): string {
	const lines: string[] = [
		"# Eval Scoreboard",
		"",
		"Auto-generated from `benchmark.jsonl`. Do not edit manually — re-runs update this file.",
		"",
		"Covers coding ToolUse_* rows and plant/consumer metrics (Dot first) plus cost/latency.",
		"",
	];

	if (history.length === 0) {
		lines.push("_No runs recorded yet._");
		return lines.join("\n");
	}

	// Run history table — most recent first
	lines.push("## Run History", "");
	lines.push("| Date | Commit | Model | Kind | Pass | Score | OAE | Latency | Cost |");
	lines.push("|---|---|---|---|---|---|---|---|---|");

	for (const r of [...history].reverse()) {
		// eslint-disable-next-line no-magic-numbers
		const date = r.ts.slice(0, 10);
		// eslint-disable-next-line no-magic-numbers
		const pct = (r.passRate * 100).toFixed(0);
		// eslint-disable-next-line no-magic-numbers
		const score = (r.meanScore * 100).toFixed(0);
		// eslint-disable-next-line no-magic-numbers
		const oae = (r.meanOae * 100).toFixed(1);
		const kind = r.kind ?? "coding";
		const latency =
			r.meanDurationMs !== undefined ? `${Math.round(r.meanDurationMs)}ms` : "—";
		const cost =
			// eslint-disable-next-line no-magic-numbers
			r.meanCostUsd !== undefined ? `$${r.meanCostUsd.toFixed(4)}` : "—";
		lines.push(
			`| ${date} | \`${r.commit}\` | ${r.model} | ${kind} | **${r.nPass}/${r.nTotal}** (${pct}%) | ${score}% | ${oae}% | ${latency} | ${cost} |`,
		);
	}

	// Per-evaluation breakdown — latest run + trend vs previous
	const latest = history[history.length - 1]!;
	const prev = history.length >= 2 ? history[history.length - 2] : undefined;

	const evalIds = Object.keys(latest.evals);

	lines.push("", "## Per-Evaluation (latest run)", "");
	lines.push("| Evaluation | Kind | Status | Score | Duration | Cost | Trend | Notes |");
	lines.push("|---|---|---|---|---|---|---|---|");

	for (const id of evalIds) {
		const e = latest.evals[id]!;
		const icon = e.pass ? "✓" : "✗";
		// eslint-disable-next-line no-magic-numbers
		const score = `${(e.score * 100).toFixed(0)}%`;
		const kind = e.kind ?? "coding";
		const duration = e.durationMs !== undefined ? `${Math.round(e.durationMs)}ms` : "—";
		const cost =
			// eslint-disable-next-line no-magic-numbers
			e.costUsd !== undefined ? `$${e.costUsd.toFixed(4)}` : "—";

		let trend = "—";
		const prevE = prev?.evals[id];
		if (prevE) {
			if (!prevE.pass && e.pass) trend = "↑ improved";
			else if (prevE.pass && !e.pass) trend = "↓ regressed";
			// eslint-disable-next-line no-magic-numbers
			else if (prevE.score < e.score - 0.05) trend = "↑";
			// eslint-disable-next-line no-magic-numbers
			else if (prevE.score > e.score + 0.05) trend = "↓";
			else trend = "→";
		}

		// eslint-disable-next-line no-magic-numbers
		const note = e.error ? e.error.slice(0, 80) : "";
		lines.push(`| ${id} | ${kind} | ${icon} | ${score} | ${duration} | ${cost} | ${trend} | ${note} |`);
	}

	appendPlantMetricsSection(lines, latest);
	appendUsageMetricsSection(lines, latest);
	appendCostLatencySection(lines, history);

	// Aggregate stats
	lines.push("", "## Aggregate Stats (all runs)", "");
	lines.push("| Evaluation | Runs | Pass Rate | Best Score | Latest |");
	lines.push("|---|---|---|---|---|");

	for (const id of evalIds) {
		const allRuns = history.filter((r) => id in r.evals);
		const passCount = allRuns.filter((r) => r.evals[id]!.pass).length;
		// eslint-disable-next-line no-magic-numbers
		const passRate = allRuns.length > 0 ? `${((passCount / allRuns.length) * 100).toFixed(0)}%` : "—";
		const bestScore = Math.max(...allRuns.map((r) => r.evals[id]!.score));
		const latestScore = latest.evals[id]!.score;
		lines.push(
			// eslint-disable-next-line no-magic-numbers
			`| ${id} | ${allRuns.length} | ${passRate} | ${(bestScore * 100).toFixed(0)}% | ${(latestScore * 100).toFixed(0)}% |`,
		);
	}

	// eslint-disable-next-line no-magic-numbers
	const updatedAt = `${latest.ts.slice(0, 10)} ${latest.ts.slice(11, 19)} UTC`;
	lines.push("", `_Last updated: ${updatedAt}_`);
	return `${lines.join("\n")}\n`;
}

/** Append a plant-metrics table for the latest run when plant rows exist. */
function appendPlantMetricsSection(lines: string[], latest: RunRecord): void {
	const plantRows = Object.entries(latest.evals).filter(([, e]) => e.kind === "plant");
	if (plantRows.length === 0) return;

	lines.push("", "## Plant Metrics (latest run)", "");
	const header = ["Evaluation", ...PLANT_METRIC_KEYS];
	lines.push(`| ${header.join(" | ")} |`);
	lines.push(`|${header.map(() => "---").join("|")}|`);

	for (const [id, e] of plantRows) {
		const cells = PLANT_METRIC_KEYS.map((key) => formatMetricCell(e.metrics?.[key]));
		lines.push(`| ${id} | ${cells.join(" | ")} |`);
	}
}

/** Append coding usage / intensity metrics (tokens, cost, tok/P). */
function appendUsageMetricsSection(lines: string[], latest: RunRecord): void {
	const usageRows = Object.entries(latest.evals).filter(
		([, e]) => e.kind === "coding" || (e.metrics !== undefined && e.kind !== "plant"),
	);
	if (usageRows.length === 0) return;

	lines.push("", "## Usage / Intensity (latest run)", "");
	const header = ["Evaluation", ...CODING_USAGE_METRIC_KEYS];
	lines.push(`| ${header.join(" | ")} |`);
	lines.push(`|${header.map(() => "---").join("|")}|`);

	for (const [id, e] of usageRows) {
		const cells = CODING_USAGE_METRIC_KEYS.map((key) => formatMetricCell(e.metrics?.[key]));
		lines.push(`| ${id} | ${cells.join(" | ")} |`);
	}
}

/** Append cost/latency history when any run recorded duration or USD cost. */
function appendCostLatencySection(lines: string[], history: RunRecord[]): void {
	const withCostOrLatency = history.filter(
		(r) => r.meanDurationMs !== undefined || r.meanCostUsd !== undefined,
	);
	if (withCostOrLatency.length === 0) return;

	lines.push("", "## Cost / Latency (run history)", "");
	lines.push("| Date | Model | Mean Latency | Mean Cost | Pass Rate |");
	lines.push("|---|---|---|---|---|");

	for (const r of [...withCostOrLatency].reverse()) {
		// eslint-disable-next-line no-magic-numbers
		const date = r.ts.slice(0, 10);
		const latency =
			r.meanDurationMs !== undefined ? `${Math.round(r.meanDurationMs)}ms` : "—";
		const cost =
			// eslint-disable-next-line no-magic-numbers
			r.meanCostUsd !== undefined ? `$${r.meanCostUsd.toFixed(4)}` : "—";
		// eslint-disable-next-line no-magic-numbers
		const pct = `${(r.passRate * 100).toFixed(0)}%`;
		lines.push(`| ${date} | ${r.model} | ${latency} | ${cost} | ${pct} |`);
	}
}

/** Format a metric cell for markdown tables. */
function formatMetricCell(value: number | null | undefined): string {
	if (value === null || value === undefined || Number.isNaN(value)) return "—";
	if (Number.isInteger(value)) return String(value);
	// eslint-disable-next-line no-magic-numbers
	return value.toFixed(3);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 *
 */
function gitCommitSha(): string {
	try {
		return execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
	} catch {
		return "unknown";
	}
}
