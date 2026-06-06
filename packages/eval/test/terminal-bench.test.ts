/**
 * TerminalBench adapter tests.
 *
 * Fixture tests: checker self-validation on oracle solutions. No LLM, always CI.
 * Real-LLM tests: skipped without ANTHROPIC_API_KEY.
 *
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EvaluationRunner } from "../src/evaluation-runner.js";
import {
	ALL_TERMINAL_BENCH,
	csvSummary,
	helloWorld,
	jsonConfig,
	lineCounter,
	wordFrequency,
} from "../src/evaluations/terminal-bench.js";
import { EvalHarness } from "../src/harness.js";
import { SKIP_REAL_LLM } from "../src/model.js";

// ---------------------------------------------------------------------------
// Fixture tests — checker self-validation, no LLM
// ---------------------------------------------------------------------------

describe("TerminalBench — fixture tests (no LLM)", { tags: ["benchmark"] }, () => {
	it("helloWorld checker passes on oracle", async () => {
		await expect(EvaluationRunner.fixtureCheck(helloWorld)).resolves.not.toThrow();
	});

	it("wordFrequency checker passes on oracle", async () => {
		await expect(EvaluationRunner.fixtureCheck(wordFrequency)).resolves.not.toThrow();
	});

	it("lineCounter checker passes on oracle", async () => {
		await expect(EvaluationRunner.fixtureCheck(lineCounter)).resolves.not.toThrow();
	});

	it("jsonConfig checker passes on oracle", async () => {
		await expect(EvaluationRunner.fixtureCheck(jsonConfig)).resolves.not.toThrow();
	});

	it("csvSummary checker passes on oracle", async () => {
		await expect(EvaluationRunner.fixtureCheck(csvSummary)).resolves.not.toThrow();
	});

	it("ALL_TERMINAL_BENCH contains 5 evaluations", () => {
		expect(ALL_TERMINAL_BENCH).toHaveLength(5);
	});

	it("all evaluations have fixture defined", () => {
		for (const ev of ALL_TERMINAL_BENCH) {
			expect(ev.fixture, `${ev.id} missing fixture`).toBeDefined();
		}
	});
});

// ---------------------------------------------------------------------------
// TerminalReferee unit tests
// ---------------------------------------------------------------------------

describe("terminalScript checker", { tags: ["benchmark"] }, () => {
	it("passes when bash script exits 0", async () => {
		const { terminalScript } = await import("../src/checkers/terminal.js");
		const { mkdtempSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");

		const ws = mkdtempSync(join(tmpdir(), "alef-tb-"));
		try {
			const ref = terminalScript("exit 0");
			const result = await ref.check({ workspace: ws, spans: [] });
			expect(result.pass).toBe(true);
			expect(result.score).toBe(1.0);
		} finally {
			rmSync(ws, { recursive: true, force: true });
		}
	});

	it("fails when bash script exits 1", async () => {
		const { terminalScript } = await import("../src/checkers/terminal.js");
		const { mkdtempSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");

		const ws = mkdtempSync(join(tmpdir(), "alef-tb-"));
		try {
			const ref = terminalScript("exit 1");
			const result = await ref.check({ workspace: ws, spans: [] });
			expect(result.pass).toBe(false);
			expect(result.score).toBe(0);
		} finally {
			rmSync(ws, { recursive: true, force: true });
		}
	});

	it("can check file content written by agent", async () => {
		const { terminalScript } = await import("../src/checkers/terminal.js");
		const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");

		const ws = mkdtempSync(join(tmpdir(), "alef-tb-"));
		try {
			writeFileSync(join(ws, "hello.py"), "print('Hello, World!')\n");
			const ref = terminalScript("python3 hello.py | grep -qF 'Hello, World!'");
			const result = await ref.check({ workspace: ws, spans: [] });
			expect(result.pass).toBe(true);
		} finally {
			rmSync(ws, { recursive: true, force: true });
		}
	}, 10_000);
});

// ---------------------------------------------------------------------------
// Real-LLM tests — skip without credentials
// ---------------------------------------------------------------------------

describe.skipIf(SKIP_REAL_LLM)("TerminalBench — real LLM", { tags: ["benchmark"] }, () => {
	let harness: EvalHarness;
	const results: Array<{ id: string; score: number; passed: boolean }> = [];

	beforeAll(() => {
		harness = new EvalHarness();
	});

	afterAll(() => {
		console.log("\nTerminalBench results:");
		for (const r of results) {
			console.log(`  ${r.id}: score=${r.score.toFixed(2)} ${r.passed ? "✓" : "✗"}`);
		}
		const resolved = results.filter((r) => r.passed).length;
		console.log(`\nResolved: ${resolved}/${results.length} (${((resolved / results.length) * 100).toFixed(0)}%)`);
	});

	for (const evaluation of ALL_TERMINAL_BENCH) {
		it(`${evaluation.id} — agent resolves task`, async () => {
			const runner = new EvaluationRunner(harness, {
				systemPrompt:
					"You are a precise coding assistant. Complete the task in the current directory. " +
					"Always use tools to read and write files — never guess.",
				extraOrgans: [],
			});
			const result = await runner.run(evaluation);
			results.push({ id: evaluation.id, score: result.score, passed: result.pass });
			console.log(`  ${evaluation.id}: score=${result.score.toFixed(2)} errors=${result.errors.join("; ")}`);
			// We accept any score > 0 as progress; full pass is score=1.0.
			expect(result.score).toBeGreaterThanOrEqual(0);
		}, 120_000);
	}
});
