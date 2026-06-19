/**
 * Real-LLM evaluation suite.
 *
 * 12 evaluations run concurrently in a bounded pool.
 * Pool size: ALEF_EVAL_CONCURRENCY (default 3).
 * Spans are isolated per eval via traceId — no global exporter reset needed.
 * 429 / RESOURCE_EXHAUSTED errors retry with exponential backoff in organ-llm.
 *
 * Run:
 *   cd packages/eval
 *   ALEF_EVAL_CONCURRENCY=4 npx vitest --run test/real-llm.test.ts
 */

import { resolve } from "node:path";

import { createAgentLoop } from "@dpopsuev/alef-reasoner";
import { InMemorySessionStore } from "@dpopsuev/alef-testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Evaluation } from "../../eval/src/evaluation.js";
import * as multiTurnEvals from "../../eval/src/evaluations/multi-turn.js";
import * as readOnlyEvals from "../../eval/src/evaluations/read-only.js";
import * as writeEvals from "../../eval/src/evaluations/write.js";
import type { EvaluationResult } from "../../eval/src/index.js";
import { EvalHarness, EvaluationRunner } from "../../eval/src/index.js";
import { getEvalModel, SKIP_REAL_LLM } from "../../eval/src/model.js";
import { appendRunRecord, buildRunRecord, loadRunHistory, writeScoreboard } from "../../eval/src/scoreboard.js";
import { createCodingAgentStack } from "../src/index.js";

const BENCHMARK_PATH = resolve(__dirname, "../../eval/benchmark.jsonl");
const SCOREBOARD_PATH = resolve(__dirname, "../../eval/SCOREBOARD.md");

// ---------------------------------------------------------------------------
// Eval registry — all 12 evaluations
// ---------------------------------------------------------------------------

const ALL_EVALS: Evaluation[] = [
	// ReadOnly (4)
	readOnlyEvals.planRefactoring,
	readOnlyEvals.auditModule,
	readOnlyEvals.blastRadius,
	readOnlyEvals.contextWarming,
	// Write (5)
	writeEvals.createHTTPServer,
	writeEvals.addTypeExport,
	writeEvals.fixFailingTest,
	writeEvals.refactorAsync,
	writeEvals.writeMiddleware,
	// MultiTurn (3)
	multiTurnEvals.proposeFirst,
	multiTurnEvals.memoRecall,
	multiTurnEvals.approveProposal,
];

// ---------------------------------------------------------------------------
// AIMD concurrency scheduler — TCP congestion control applied to API rate limits
// RFC 5681: Multiplicative Decrease on throttle, Additive Increase on recovery.
// ---------------------------------------------------------------------------

class AimdScheduler {
	private concurrency: number;
	private readonly max: number;
	private streak = 0; // consecutive successes since last decrease
	private readonly successThreshold: number;

	constructor(initial: number, max: number, successThreshold = 3) {
		this.concurrency = initial;
		this.max = max;
		this.successThreshold = successThreshold;
	}

	/** Multiplicative decrease on 429 / throttle. */
	onRetry(attempt: number, reason: string): void {
		const prev = this.concurrency;
		this.concurrency = Math.max(1, Math.floor(this.concurrency / 2));
		this.streak = 0;
		if (this.concurrency !== prev)
			console.warn(
				`[AIMD] throttle (attempt ${attempt}) — concurrency ${prev}→${this.concurrency} (${reason.slice(0, 50)})`,
			);
	}

	/** Additive increase after N consecutive successes. */
	onSuccess(): void {
		if (++this.streak >= this.successThreshold && this.concurrency < this.max) {
			this.concurrency++;
			this.streak = 0;
			console.log(`[AIMD] recovery — concurrency ↑${this.concurrency}`);
		}
	}

	get current(): number {
		return this.concurrency;
	}
}

/**
 * Run evaluations through an AIMD-controlled concurrent pool.
 * Pool adapts: shrinks on 429 (MD), grows on consecutive successes (AI).
 * Each eval gets a fresh Agent + organ-llm wired to the scheduler's onRetry.
 */
async function runPool(evals: Evaluation[], maxConcurrency: number): Promise<EvaluationResult[]> {
	const scheduler = new AimdScheduler(Math.min(3, maxConcurrency), maxConcurrency);
	const results: (EvaluationResult | null)[] = new Array(evals.length).fill(null);
	const queue = evals.map((e, i) => ({ eval: e, index: i }));
	const inFlight: Promise<void>[] = [];

	async function runOne(item: { eval: Evaluation; index: number }): Promise<void> {
		const harness = new EvalHarness();
		const model = getEvalModel();
		const runner = new EvaluationRunner(harness, {
			asyncOrganFactory: async (workspace, signal) => {
				const sessionStore = new InMemorySessionStore();
				const stack = await createCodingAgentStack({
					cwd: workspace,
					model,
					getSignal: () => signal,
					onRetry: (attempt, reason) => scheduler.onRetry(attempt, reason),
					sessionStore,
				});
				const llm = createAgentLoop({
					model,
					getSignal: () => signal,
					schemaResolver: (name) => stack.pipeline.getSchemaResolver()?.(name),
					onRetry: (attempt, reason) => scheduler.onRetry(attempt, reason),
					phaseTimeoutMs: 100,
				});
				return [...stack.organs, llm];
			},
			maxErrorRate: 0.5,
		});
		results[item.index] = await runner.run(item.eval);
		scheduler.onSuccess();
	}

	let next = 0;
	function dispatch(): void {
		while (inFlight.length < scheduler.current && next < queue.length) {
			const item = queue[next++];
			const p = runOne(item).finally(() => {
				inFlight.splice(inFlight.indexOf(p), 1);
				dispatch();
			});
			inFlight.push(p);
		}
	}

	dispatch();
	while (inFlight.length > 0) await Promise.race(inFlight);

	return results.filter((r): r is EvaluationResult => r !== null);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeAll(() => {
	if (SKIP_REAL_LLM) console.log("No provider credentials — skipping real-LLM suite");
	else {
		const concurrency = Number(process.env.ALEF_EVAL_CONCURRENCY) || 3;
		console.log(`Real-LLM suite: model=${getEvalModel().id}  concurrency=${concurrency}`);
	}
});

// ---------------------------------------------------------------------------
// Results — collected by the single it() for afterAll
// ---------------------------------------------------------------------------

let allResults: EvaluationResult[] = [];

afterAll(async () => {
	if (SKIP_REAL_LLM || allResults.length === 0) return;

	const passed = allResults.filter((r) => r.pass).length;
	const meanScore = allResults.reduce((a, r) => a + r.score, 0) / allResults.length;

	console.log(`\n╔═══ REAL-LLM REPORT ═══`);
	console.log(`Passed: ${passed}/${allResults.length}  Mean score: ${(meanScore * 100).toFixed(1)}%`);
	for (const r of allResults) {
		const icon = r.pass ? "✓" : "✗";
		const err = r.errors[0] ? ` — ${r.errors[0].slice(0, 80)}` : "";
		console.log(`  ${icon} ${r.metrics.scenario} score=${(r.score * 100).toFixed(0)}%${err}`);
	}

	const model = getEvalModel();
	const record = buildRunRecord(
		model.id,
		model.provider ?? "unknown",
		allResults.map((r) => ({
			id: r.metrics.scenario,
			pass: r.pass,
			score: r.score,
			error: r.errors[0],
			durationMs: r.metrics.durationMs,
			oae: r.metrics.oae,
		})),
	);
	await appendRunRecord(BENCHMARK_PATH, record);
	const history = await loadRunHistory(BENCHMARK_PATH);
	await writeScoreboard(SCOREBOARD_PATH, history);
	console.log(`Scoreboard updated — ${history.length} run(s) recorded.`);
});

// ---------------------------------------------------------------------------
// Single concurrent test — all evals in one pool
// ---------------------------------------------------------------------------

describe.skipIf(SKIP_REAL_LLM)("coding agent evaluations", { tags: ["real-llm"] }, () => {
	it(`runs all ${ALL_EVALS.length} evaluations concurrently`, async () => {
		const concurrency = Number(process.env.ALEF_EVAL_CONCURRENCY) || 3;
		allResults = await runPool(ALL_EVALS, concurrency);

		// Assert each eval individually so failures are named clearly.
		const failures: string[] = [];
		for (const r of allResults) {
			if (!r.pass) {
				failures.push(`${r.metrics.scenario}: ${r.errors.join("; ")}`);
			}
		}

		expect(failures, failures.join("\n")).toHaveLength(0);
	}, 420_000); // Longest scenario (300s) × ceil(evals/concurrency) + buffer
});
