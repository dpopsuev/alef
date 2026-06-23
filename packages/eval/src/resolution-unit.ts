/**
 * ResolutionUnit \u2014 evaluate a single adapter in isolation.
 *
 * No LLM. No blueprint. No real dependencies.
 * Motor events are injected from PortStubs (fixture JSON).
 * Sense events are collected and scored against a ScoreCard.
 *
 * Resolution levels (mirrors Tako calibrate.multi_resolution):
 *   unit       \u2014 one adapter, all ports stubbed
 *   pairwise   \u2014 two adapters composed, outer ports stubbed  (future)
 *   integrated \u2014 full blueprint, no stubs (existing EvalHarness)
 *
 */

import { randomUUID } from "node:crypto";
import { type Adapter, type EventMessage, gimpedAdapter, InProcessNerve, isGimped } from "@dpopsuev/alef-kernel";

// ---------------------------------------------------------------------------
// PortStub \u2014 canned Motor payload for one tool
// ---------------------------------------------------------------------------

/**
 * A PortStub declares a canned Motor payload for a named tool.
 * The adapter receives this payload and its Sense response is captured.
 *
 * Mirrors Tako calibrate.PortStubs: stubs at port boundaries so a circuit
 * can be measured in isolation without invoking real sub-circuits.
 */
export interface PortStub {
	/** Tool name (e.g. "fs.read"). Must match a tool in the adapter. */
	tool: string;
	/** Motor payload injected. Should satisfy the tool's inputSchema. */
	payload: Record<string, unknown>;
	/** Optional ground truth for scoring. Passed to the scorer. */
	groundTruth?: Record<string, unknown>;
	/** Human label for this test case. */
	label?: string;
}

// ---------------------------------------------------------------------------
// UnitMetric \u2014 per-case result
// ---------------------------------------------------------------------------

export interface UnitCaseResult {
	tool: string;
	label: string;
	/** Sense event received (undefined if timed out). */
	sense: EventMessage | undefined;
	/** true if a Sense event arrived (regardless of isError). */
	responded: boolean;
	/** true if sense.isError === true. */
	isError: boolean;
	/** User-supplied score from scorer (0\u20131). */
	score: number;
	/** Human-readable detail from scorer. */
	detail: string;
	/** Wall-clock duration from Motor publish to Sense arrival in ms. */
	durationMs: number;
}

// ---------------------------------------------------------------------------
// UnitScorer \u2014 plug-in scoring
// ---------------------------------------------------------------------------

export type UnitScorer = (
	sensePayload: Record<string, unknown> | undefined,
	groundTruth: Record<string, unknown> | undefined,
	stub: PortStub,
) => { score: number; detail: string };

export const defaultUnitScorer: UnitScorer = (sensePayload, _groundTruth, _stub) => {
	if (!sensePayload) return { score: 0, detail: "no response" };
	return { score: 1, detail: "responded" };
};

// ---------------------------------------------------------------------------
// UnitEvalConfig
// ---------------------------------------------------------------------------

export interface UnitEvalConfig {
	/** The adapter under test. */
	adapter: Adapter;
	/** Canned Motor payloads to inject. */
	stubs: PortStub[];
	/** Optional scorer. Default: 1.0 if response received, 0 otherwise. */
	scorer?: UnitScorer;
	/** Timeout per Motor\u2192Sense probe in ms. Default: 5000. */
	timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// UnitEvalReport
// ---------------------------------------------------------------------------

export interface UnitEvalReport {
	adapter: string;
	resolution: "unit";
	/** true if the adapter is gimped (no tools, no subscriptions). */
	gimped: boolean;
	cases: UnitCaseResult[];
	/** Mean score across all cases (0\u20131). */
	meanScore: number;
	/** Fraction of cases that received a Sense event. */
	responseRate: number;
	/** Fraction of cases where sense.isError === true. */
	errorRate: number;
	/** Wall-clock duration of the entire run in ms. */
	elapsedMs: number;
}

// ---------------------------------------------------------------------------
// runUnitEval \u2014 the entry point
// ---------------------------------------------------------------------------

/**
 * Run a single adapter against a set of PortStubs and return a UnitEvalReport.
 *
 * The adapter is mounted on a fresh isolated InProcessNerve for each run,
 * then unmounted. No state leaks between calls.
 *
 * @example
 * const report = await runUnitEval({
 *   adapter: createFsAdapter({ cwd: "/tmp/workspace" }),
 *   stubs: [
 *     { tool: "fs.read", payload: { path: "README.md" }, label: "read readme" },
 *     { tool: "fs.grep", payload: { pattern: "TODO" }, label: "grep todos" },
 *   ],
 *   scorer: (sense, _gt, _stub) => ({
 *     score: sense && !sense.isError ? 1 : 0,
 *     detail: sense?.isError ? "error" : "ok",
 *   }),
 * });
 * console.log(report.meanScore, report.responseRate);
 */
export async function runUnitEval(cfg: UnitEvalConfig): Promise<UnitEvalReport> {
	const start = Date.now();
	const timeoutMs = cfg.timeoutMs ?? 5000;
	const scorer = cfg.scorer ?? defaultUnitScorer;
	const adapter = cfg.adapter;
	const gimped = isGimped(adapter);

	const cases: UnitCaseResult[] = [];

	// Mount the adapter on a fresh nerve
	const nerve = new InProcessNerve();
	const unmount = adapter.mount(nerve.asBus());

	try {
		for (const stub of cfg.stubs) {
			const caseStart = Date.now();
			const correlationId = randomUUID();

			const sense = await probeMotor(
				nerve,
				stub.tool,
				{ ...stub.payload, toolCallId: correlationId },
				correlationId,
				timeoutMs,
			);
			const durationMs = Date.now() - caseStart;

			const { score, detail } = scorer(
				sense?.payload as Record<string, unknown> | undefined,
				stub.groundTruth,
				stub,
			);

			cases.push({
				tool: stub.tool,
				label: stub.label ?? stub.tool,
				sense: sense ?? undefined,
				responded: sense !== null,
				isError: sense?.isError === true,
				score,
				detail,
				durationMs,
			});
		}
	} finally {
		unmount();
	}

	const n = cases.length;
	const meanScore = n === 0 ? 0 : cases.reduce((a, c) => a + c.score, 0) / n;
	const responseRate = n === 0 ? 0 : cases.filter((c) => c.responded).length / n;
	const errorRate = n === 0 ? 0 : cases.filter((c) => c.isError).length / n;

	return {
		adapter: adapter.name,
		resolution: "unit",
		gimped,
		cases,
		meanScore,
		responseRate,
		errorRate,
		elapsedMs: Date.now() - start,
	};
}

/**
 * Run the same UnitEvalConfig with adapter replaced by a gimpedAdapter,
 * returning the baseline (ablated) report. Use as denominator in ablation:
 *
 *   const real = await runUnitEval({ adapter: myAdapter, stubs });
 *   const base = await runUnitEvalBaseline({ adapter: myAdapter, stubs });
 *   const contribution = real.meanScore - base.meanScore;
 */
export async function runUnitEvalBaseline(cfg: UnitEvalConfig): Promise<UnitEvalReport> {
	return runUnitEval({ ...cfg, adapter: gimpedAdapter(`${cfg.adapter.name}.gimped`) });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function probeMotor(
	nerve: InProcessNerve,
	toolName: string,
	payload: Record<string, unknown>,
	correlationId: string,
	timeoutMs: number,
): Promise<EventMessage | null> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			off();
			resolve(null);
		}, timeoutMs);

		const nerveView = nerve.asBus();
		const off = nerveView.event.subscribe(toolName, (event) => {
			if (event.correlationId === correlationId) {
				clearTimeout(timer);
				off();
				resolve(event);
			}
		});

		nerveView.command.publish({ type: toolName, correlationId, payload });
	});
}
