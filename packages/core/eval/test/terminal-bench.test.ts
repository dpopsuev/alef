/**
 * TerminalBench harness self-tests — fixture/checker validation, no LLM.
 *
 * Real-LLM bench runs live in alef-coding-agent/test/terminal-bench.test.ts.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { terminalScript } from "../src/checkers/terminal.js";
import { EvaluationRunner } from "../src/evaluation-runner.js";
import {
	ALL_TERMINAL_BENCH,
	csvSummary,
	helloWorld,
	jsonConfig,
	lineCounter,
	wordFrequency,
} from "../src/evaluations/terminal-bench.js";

// ---------------------------------------------------------------------------
// Fixture tests — checker self-validation, no LLM
// ---------------------------------------------------------------------------

describe("TerminalBench — fixture tests (no LLM)", { tags: ["integration"] }, () => {
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
// terminalScript checker unit tests
// ---------------------------------------------------------------------------

describe("terminalScript checker", { tags: ["integration"] }, () => {
	it("passes when bash script exits 0", async () => {
		const ws = mkdtempSync(join(tmpdir(), "alef-tb-"));
		try {
			const ref = terminalScript("exit 0");
			const result = await ref.check({ workspace: ws, spans: [] });
			expect(result.pass).toBe(true);
		} finally {
			rmSync(ws, { recursive: true, force: true });
		}
	}, 10_000);

	it("fails when bash script exits 1", async () => {
		const ws = mkdtempSync(join(tmpdir(), "alef-tb-"));
		try {
			const ref = terminalScript("exit 1");
			const result = await ref.check({ workspace: ws, spans: [] });
			expect(result.pass).toBe(false);
		} finally {
			rmSync(ws, { recursive: true, force: true });
		}
	}, 10_000);

	it("can check file content written by agent", async () => {
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
