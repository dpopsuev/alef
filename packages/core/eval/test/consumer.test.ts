import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpanStatusCode } from "@opentelemetry/api";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildConsumerRunRecord,
	buildPlantMetrics,
	countToolErrors,
	createDotConsumerEval,
	DOT_PLANT_DEFINITION,
	extractProgressSteps,
	generateScoreboard,
	runConsumerEval,
	runConsumerSuite,
	scoreConsumerMetrics,
	scoreDotEpisode,
} from "../src/index.js";
import { globalSpanExporter } from "../src/otel-setup.js";

const dirs: string[] = [];
function tmp(): string {
	const d = mkdtempSync(join(tmpdir(), "alef-consumer-"));
	dirs.push(d);
	return d;
}

afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("consumer plant metrics", { tags: ["unit"] }, () => {
	it("extracts ProgressTelemetry steps and averages tok/P", () => {
		const steps = extractProgressSteps([
			{ type: "noise", payload: {} },
			{
				type: "telemetry.progress.step",
				payload: { tokens: 10, progress: 2, tok_per_progress: 5 },
			},
			{
				type: "telemetry.progress.step",
				payload: { tokens: 20, progress: 2, tok_per_progress: 10 },
			},
		]);
		expect(steps).toHaveLength(2);
		const { metrics } = buildPlantMetrics({
			insideMs: 800,
			totalMs: 1000,
			terminalInside: true,
			survivalTicks: 4,
			progressSteps: steps,
			toolErrorCount: 0,
		});
		expect(metrics.in_circle_ratio).toBe(0.8);
		expect(metrics.terminal_inside).toBe(1);
		expect(metrics.progress_steps).toBe(2);
		expect(metrics.tok_per_progress).toBe(7.5);
		expect(metrics.tool_errors).toBe(0);
		expect(metrics.survival_ticks).toBe(4);
	});

	it("counts tool errors from llm.tool-end and validation events", () => {
		expect(
			countToolErrors([
				{ type: "llm.tool-end", payload: { ok: true } },
				{ type: "llm.tool-end", payload: { ok: false } },
				{ type: "llm.tool-validation-error", payload: {} },
			]),
		).toBe(2);
	});

	it("scores Dot plant definition against pass thresholds", () => {
		const raw = scoreDotEpisode({
			episode: {
				final: { inside: true, status: "ok", tick: 5 },
				insideMs: 900,
				totalMs: 1000,
			},
			events: [
				{
					type: "telemetry.progress.step",
					payload: { tokens: 8, progress: 2, tok_per_progress: 4 },
				},
			],
			durationMs: 1200,
		});
		const scored = scoreConsumerMetrics(DOT_PLANT_DEFINITION, raw.metrics);
		expect(scored.pass).toBe(true);
		expect(scored.score).toBeGreaterThan(0.8);
	});

	it("fails when terminal_inside is 0", () => {
		const raw = scoreDotEpisode({
			episode: {
				final: { inside: false, status: "game_over", tick: 2 },
				insideMs: 100,
				totalMs: 1000,
			},
			events: [],
			durationMs: 500,
		});
		const scored = scoreConsumerMetrics(DOT_PLANT_DEFINITION, raw.metrics);
		expect(scored.pass).toBe(false);
		expect(scored.failedKeys).toContain("terminal_inside");
	});
});

describe("consumer runner + OTLP intensity", { tags: ["unit"] }, () => {
	it("mirrors progress steps onto OTLP spans and scores the adapter", async () => {
		globalSpanExporter.reset();

		const adapter = createDotConsumerEval(async () => ({
			episode: {
				final: { inside: true, status: "ok", tick: 3 },
				insideMs: 1000,
				totalMs: 1000,
			},
			events: [
				{
					type: "telemetry.progress.step",
					payload: { tokens: 6, progress: 3, tok_per_progress: 2 },
				},
			],
		}));

		const result = await runConsumerEval(adapter, { mode: "scripted" });
		expect(result.pass).toBe(true);
		expect(result.kind).toBe("plant");
		expect(result.metrics.tok_per_progress).toBe(2);

		const spans = globalSpanExporter
			.getFinishedSpans()
			.filter((s) => s.name === "alef.telemetry.progress.step");
		expect(spans.length).toBeGreaterThanOrEqual(1);
		expect(spans[0]!.attributes["alef.tok_per_progress"]).toBe(2);
		expect(spans[0]!.attributes["alef.eval.id"]).toBe("dot-circle");
		expect(spans[0]!.status.code).toBe(SpanStatusCode.OK);
	});
});

describe("consumer suite + scoreboard", { tags: ["unit"] }, () => {
	it("runs scripted suite with baseline and emits plant+cost rows on scoreboard", async () => {
		const dir = tmp();
		const baselinePath = join(dir, "baseline.json");
		const adapter = createDotConsumerEval(async (mode) => {
			expect(mode).toBe("scripted");
			return {
				episode: {
					final: { inside: true, status: "ok", tick: 4 },
					insideMs: 950,
					totalMs: 1000,
				},
				events: [
					{
						type: "telemetry.progress.step",
						payload: { tokens: 10, progress: 2, tok_per_progress: 5 },
					},
				],
				costUsd: 0.0123,
			};
		});

		const report = await runConsumerSuite({
			mode: "scripted",
			adapters: [adapter],
			baselinePath,
		});
		expect(report.nPass).toBe(1);
		expect(report.meanCostUsd).toBeCloseTo(0.0123);
		expect(report.regressions).toHaveLength(0);

		const record = buildConsumerRunRecord("stub-model", "test", report.results);
		expect(record.kind).toBe("plant");
		expect(record.meanCostUsd).toBeCloseTo(0.0123);
		expect(record.evals["dot-circle"]?.metrics?.terminal_inside).toBe(1);

		const md = generateScoreboard([record]);
		expect(md).toContain("Plant Metrics");
		expect(md).toContain("Cost / Latency");
		expect(md).toContain("dot-circle");
		expect(md).toContain("in_circle_ratio");
	});

	it("live mode shares the same suite API", async () => {
		const adapter = createDotConsumerEval(async (mode) => {
			expect(mode).toBe("live");
			return {
				episode: {
					final: { inside: true, status: "ok", tick: 2 },
					insideMs: 500,
					totalMs: 500,
				},
				events: [
					{
						type: "telemetry.progress.step",
						payload: { tokens: 4, progress: 1, tok_per_progress: 4 },
					},
				],
			};
		});
		const report = await runConsumerSuite({ mode: "live", adapters: [adapter] });
		expect(report.mode).toBe("live");
		expect(report.nPass).toBe(1);
	});
});
