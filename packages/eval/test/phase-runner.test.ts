/**
 * PhaseEvaluationRunner — unit tests with faux LLM.
 *
 * Verifies score aggregation, retry decay, stop/continue behaviour,
 * violation reporting, and equal-weight distribution.
 */

import { fauxAssistantMessage, registerFauxProvider } from "@dpopsuev/alef-llm";
import { createAgentLoop } from "@dpopsuev/alef-organ-llm";
import { afterEach, describe, expect, it } from "vitest";
import type { Phase, PhaseEvaluation } from "../src/evaluation.js";
import { EvalHarness } from "../src/harness.js";
import { PhaseEvaluationRunner } from "../src/phase-runner.js";

// ---------------------------------------------------------------------------
// Checker factories
// ---------------------------------------------------------------------------

/** Always returns the given score. */
function alwaysScore(score: number) {
	return {
		check: () => ({ pass: score >= 1.0, score, errors: score < 1.0 ? [`score is ${score}`] : [] }),
	};
}

/** Fails the first N calls, then passes. */
function failThenPass(failCount: number) {
	let calls = 0;
	return {
		check: () => {
			calls++;
			return calls <= failCount
				? { pass: false, score: 0, errors: [`fail attempt ${calls}`] }
				: { pass: true, score: 1.0, errors: [] };
		},
	};
}

/** Returns fixed violations without failing. */
function withViolations(...messages: string[]) {
	return {
		check: () => ({ pass: false, score: 0, errors: messages }),
	};
}

// ---------------------------------------------------------------------------
// Phase builder — applies KISS defaults so tests state only what varies
// ---------------------------------------------------------------------------

const PHASE_DEFAULTS = {
	prompt: "do the thing",
	weight: undefined,
	maxRetries: 1,
	decayFactor: 0.8,
	onExhausted: "stop",
} as const satisfies Partial<Phase>;

function phase(overrides: Partial<Phase> & Pick<Phase, "name" | "checker" | "onExhausted">): Phase {
	return { ...PHASE_DEFAULTS, ...overrides };
}

// ---------------------------------------------------------------------------
// Eval builder
// ---------------------------------------------------------------------------

function phaseEval(phases: Phase[]): PhaseEvaluation {
	return { id: "test/phase-eval", toolLevel: "ReadOnly", phases, passThreshold: 0.7 };
}

// ---------------------------------------------------------------------------
// Runner factory — faux LLM answers every send() with "ok"
// ---------------------------------------------------------------------------

function makeRunner() {
	const faux = registerFauxProvider();
	faux.setResponses(Array.from({ length: 50 }, () => fauxAssistantMessage("ok")));

	const harness = new EvalHarness();
	const runner = new PhaseEvaluationRunner(harness, {
		organFactory: (signal) => [createAgentLoop({ model: faux.getModel(), apiKey: "faux", getSignal: () => signal })],
		scenarioTimeoutMs: 30_000,
		noiseSeeding: false,
	});

	return { runner, dispose: () => faux.unregister() };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PhaseEvaluationRunner", { tags: ["unit"] }, () => {
	const disposals: Array<() => void> = [];
	afterEach(() => {
		for (const dispose of disposals.splice(0)) dispose();
	});

	it("totalScore equals sum of phase weights when all pass on first attempt", async () => {
		const { runner, dispose } = makeRunner();
		disposals.push(dispose);

		const result = await runner.run(
			phaseEval([
				phase({ name: "phase-a", checker: alwaysScore(1.0), weight: 0.4, onExhausted: "stop" }),
				phase({ name: "phase-b", checker: alwaysScore(1.0), weight: 0.6, onExhausted: "stop" }),
			]),
		);

		const [a, b] = result.phases;
		expect(a?.attempts).toBe(1);
		expect(a?.finalScore).toBe(1.0);
		expect(a?.weightedScore).toBeCloseTo(0.4);
		expect(b?.weightedScore).toBeCloseTo(0.6);
		expect(result.totalScore).toBeCloseTo(1.0);
		expect(result.passed).toBe(true);
	});

	it("finalScore is penalised by decayFactor when a phase needs one retry", async () => {
		const { runner, dispose } = makeRunner();
		disposals.push(dispose);

		const result = await runner.run(
			phaseEval([
				phase({
					name: "retried",
					checker: failThenPass(1),
					weight: 1.0,
					maxRetries: 2,
					decayFactor: 0.8,
					onExhausted: "stop",
				}),
			]),
		);

		const [retried] = result.phases;
		expect(retried?.attempts).toBe(2);
		expect(retried?.rawScore).toBe(1.0);
		expect(retried?.finalScore).toBeCloseTo(0.8); // 1.0 × 0.8^1
		expect(result.passed).toBe(true); // 0.8 ≥ 0.7
	});

	it("remaining phases are skipped when a blocker exhausts with onExhausted:stop", async () => {
		const { runner, dispose } = makeRunner();
		disposals.push(dispose);

		const result = await runner.run(
			phaseEval([
				phase({ name: "blocker", checker: alwaysScore(0), weight: 0.5, maxRetries: 0, onExhausted: "stop" }),
				phase({ name: "skipped", checker: alwaysScore(1.0), weight: 0.5, maxRetries: 0, onExhausted: "continue" }),
			]),
		);

		expect(result.phases[0]?.skipped).toBe(false);
		expect(result.phases[1]?.skipped).toBe(true);
		expect(result.passed).toBe(false);
	});

	it("run continues past an exhausted phase when onExhausted:continue", async () => {
		const { runner, dispose } = makeRunner();
		disposals.push(dispose);

		const result = await runner.run(
			phaseEval([
				phase({ name: "weak", checker: alwaysScore(0), weight: 0.1, maxRetries: 0, onExhausted: "continue" }),
				phase({ name: "strong", checker: alwaysScore(1.0), weight: 0.9, maxRetries: 0, onExhausted: "stop" }),
			]),
		);

		expect(result.phases[0]?.skipped).toBe(false);
		expect(result.phases[1]?.skipped).toBe(false);
		expect(result.totalScore).toBeCloseTo(0.9); // 0×0.1 + 1.0×0.9
		expect(result.passed).toBe(true);
	});

	it("violations from the final checker attempt appear in PhaseResult", async () => {
		const { runner, dispose } = makeRunner();
		disposals.push(dispose);

		const result = await runner.run(
			phaseEval([
				phase({
					name: "failing",
					checker: withViolations("missing export", "wrong type"),
					weight: 1.0,
					maxRetries: 0,
					onExhausted: "continue",
				}),
			]),
		);

		expect(result.phases[0]?.violations).toEqual(["missing export", "wrong type"]);
	});

	it("assigns equal weights when phases declare none", async () => {
		const { runner, dispose } = makeRunner();
		disposals.push(dispose);

		const result = await runner.run(
			phaseEval([
				phase({ name: "p1", checker: alwaysScore(1.0), onExhausted: "stop" }),
				phase({ name: "p2", checker: alwaysScore(1.0), onExhausted: "stop" }),
				phase({ name: "p3", checker: alwaysScore(1.0), onExhausted: "stop" }),
			]),
		);

		for (const p of result.phases) {
			expect(p.weightedScore).toBeCloseTo(1 / 3);
		}
		expect(result.totalScore).toBeCloseTo(1.0);
	});
});
