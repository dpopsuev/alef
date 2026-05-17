/**
 * Fixture tests — referee self-tests, no LLM required.
 *
 * Each Evaluation with a fixture must pass its own referee.
 * This runs in CI and proves the referee is correct before any real eval.
 */

import { describe, expect, it } from "vitest";
import { EvaluationRunner } from "../src/evaluation-runner.js";
import * as write from "../src/evaluations/write.js";

describe("Fixture tests — referee self-validation (no LLM)", () => {
	// Write evaluations with fixtures
	it("CreateHTTPServer referee passes on known-good implementation", async () => {
		await expect(EvaluationRunner.fixtureCheck(write.createHTTPServer)).resolves.not.toThrow();
	});

	it("AddTypeExport referee passes on known-good implementation", async () => {
		await expect(EvaluationRunner.fixtureCheck(write.addTypeExport)).resolves.not.toThrow();
	});

	it("FixFailingTest referee passes on correct implementation", async () => {
		await expect(EvaluationRunner.fixtureCheck(write.fixFailingTest)).resolves.not.toThrow();
	});

	it("RefactorAsync referee passes on async implementation", async () => {
		await expect(EvaluationRunner.fixtureCheck(write.refactorAsync)).resolves.not.toThrow();
	});
});

describe("Referee unit tests", () => {
	it("fileContains returns score=0 for missing file", async () => {
		const { fileContains } = await import("../src/referee.js");
		const ref = fileContains("nonexistent.ts", "anything");
		const result = await ref.check({ workspace: "/tmp/nonexistent-workspace-xyz", spans: [] });
		expect(result.pass).toBe(false);
		expect(result.score).toBe(0);
	});

	it("replyContains passes when all keywords present", async () => {
		const { replyContains } = await import("../src/referee.js");
		const ref = replyContains("createServer", "refactor");
		const result = await ref.check({ workspace: "/tmp", spans: [], lastReply: "refactor the createServer function" });
		expect(result.pass).toBe(true);
		expect(result.score).toBe(1.0);
	});

	it("replyContains partial score when some keywords missing", async () => {
		const { replyContains } = await import("../src/referee.js");
		const ref = replyContains("createServer", "missing-keyword");
		const result = await ref.check({ workspace: "/tmp", spans: [], lastReply: "refactor the createServer function" });
		expect(result.pass).toBe(false);
		expect(result.score).toBe(0.5);
	});

	it("all() referee takes minimum score", async () => {
		const { all, replyContains } = await import("../src/referee.js");
		const ref = all(replyContains("found"), replyContains("missing-keyword"));
		const result = await ref.check({ workspace: "/tmp", spans: [], lastReply: "I found the answer" });
		expect(result.score).toBe(0); // min(1.0, 0) = 0
	});
});
