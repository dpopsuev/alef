/**
 * Unit tests — no infrastructure, no OTel, no filesystem.
 *
 * Layer 1: EvaluatorAdapter event counting and loop detection.
 * Layer 2: scoreSpans() pure scoring function.
 */

import { InProcessBus } from "@dpopsuev/alef-kernel/bus";
import { describe, expect, it } from "vitest";
import { EvaluatorAdapter } from "../src/evaluator-adapter.js";
import type { SpanRecord } from "../src/metrics.js";
import {
	aggregateRunUsage,
	codingUsageMetrics,
	deriveturns,
	READ_ONLY_RULES,
	scoreSpans,
	WRITE_RULES,
} from "../src/metrics.js";
import { buildRunRecord, generateScoreboard } from "../src/scoreboard.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBus() {
	const raw = new InProcessBus();
	return raw.asBus();
}

function commandMsg(type: string, correlationId = "c1") {
	return { type, correlationId, timestamp: Date.now(), payload: {} };
}

function eventMsg(type: string, correlationId = "c1") {
	return {
		type,
		correlationId,
		timestamp: Date.now(),
		payload: {},
		isError: false,
	};
}

function span(name: string, attrs: Record<string, unknown> = {}): SpanRecord {
	return { name, attributes: attrs, status: "OK", durationMs: 1 };
}

// ---------------------------------------------------------------------------
// Layer 1: EvaluatorAdapter
// ---------------------------------------------------------------------------

describe("EvaluatorAdapter — event counting", { tags: ["unit"] }, () => {
	it("counts command events", () => {
		const n = makeBus();
		const adapter = new EvaluatorAdapter();
		adapter.mount(n);

		n.command.publish(commandMsg("fs.read"));
		n.command.publish(commandMsg("fs.grep"));
		n.command.publish(commandMsg("shell.exec"));

		expect(adapter.state.commandCount).toBe(3);
	});

	it("counts event messages", () => {
		const n = makeBus();
		const adapter = new EvaluatorAdapter();
		adapter.mount(n);

		n.event.publish(eventMsg("fs.read"));
		n.event.publish(eventMsg("fs.read"));

		expect(adapter.state.eventCount).toBe(2);
	});

	it("starts with no loop detected", () => {
		const adapter = new EvaluatorAdapter();
		expect(adapter.state.loopDetected).toBe(false);
		expect(adapter.state.loopEventType).toBeUndefined();
	});

	it("unmount stops counting", () => {
		const bus = new InProcessBus();
		const n = bus.asBus();
		const adapter = new EvaluatorAdapter();
		const unmount = adapter.mount(n);

		n.command.publish(commandMsg("fs.read"));
		expect(adapter.state.commandCount).toBe(1);

		unmount();
		n.command.publish(commandMsg("fs.read"));
		expect(adapter.state.commandCount).toBe(1); // still 1
	});
});

describe("EvaluatorAdapter — loop detection", { tags: ["unit"] }, () => {
	it("detects loop when same event type exceeds threshold on same correlationId", () => {
		const n = makeBus();
		const loopCalls: string[] = [];
		const adapter = new EvaluatorAdapter({
			loopThreshold: 3,
			onLoop: (type) => loopCalls.push(type),
		});
		adapter.mount(n);

		for (let i = 0; i < 5; i++) {
			n.command.publish(commandMsg("fs.read", "corr-1"));
		}

		expect(adapter.state.loopDetected).toBe(true);
		expect(adapter.state.loopEventType).toBe("fs.read");
		expect(loopCalls).toContain("fs.read");
	});

	it("does not flag loop below threshold", () => {
		const n = makeBus();
		const adapter = new EvaluatorAdapter({ loopThreshold: 10 });
		adapter.mount(n);

		for (let i = 0; i < 5; i++) {
			n.command.publish(commandMsg("fs.read", "corr-1"));
		}

		expect(adapter.state.loopDetected).toBe(false);
	});

	it("counts per correlationId independently", () => {
		const n = makeBus();
		const adapter = new EvaluatorAdapter({ loopThreshold: 3 });
		adapter.mount(n);

		// 3 events on corr-1, 3 events on corr-2 — neither exceeds threshold of 3
		for (let i = 0; i < 3; i++) {
			n.command.publish(commandMsg("fs.read", "corr-1"));
			n.command.publish(commandMsg("fs.read", "corr-2"));
		}

		expect(adapter.state.loopDetected).toBe(false);
	});

	it("different event types on same correlationId do not trigger loop", () => {
		const n = makeBus();
		const adapter = new EvaluatorAdapter({ loopThreshold: 3 });
		adapter.mount(n);

		n.command.publish(commandMsg("fs.read", "c1"));
		n.command.publish(commandMsg("fs.grep", "c1"));
		n.command.publish(commandMsg("fs.find", "c1"));
		n.command.publish(commandMsg("shell.exec", "c1"));

		expect(adapter.state.loopDetected).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Layer 2: scoreSpans()
// ---------------------------------------------------------------------------

describe("scoreSpans — ReadOnly rules", { tags: ["unit"] }, () => {
	it("awards points for fs.read spans", () => {
		const spans = [span("alef.command/fs.read"), span("alef.command/fs.read")];
		expect(scoreSpans(spans, READ_ONLY_RULES)).toBe(20); // 2 × 10
	});

	it("awards points for fs.grep spans", () => {
		expect(scoreSpans([span("alef.command/fs.grep")], READ_ONLY_RULES)).toBe(5);
	});

	it("penalises fs.write spans", () => {
		expect(scoreSpans([span("alef.command/fs.write")], READ_ONLY_RULES)).toBe(-15);
	});

	it("penalises fs.edit spans", () => {
		expect(scoreSpans([span("alef.command/fs.edit")], READ_ONLY_RULES)).toBe(-15);
	});

	it("mixed read+write nets correctly", () => {
		const spans = [
			span("alef.command/fs.read"), // +10
			span("alef.command/fs.grep"), // +5
			span("alef.command/fs.write"), // -15
		];
		expect(scoreSpans(spans, READ_ONLY_RULES)).toBe(0);
	});

	it("returns 0 for empty spans", () => {
		expect(scoreSpans([], READ_ONLY_RULES)).toBe(0);
	});
});

describe("scoreSpans — Write rules", { tags: ["unit"] }, () => {
	it("rewards fs.write spans", () => {
		expect(scoreSpans([span("alef.command/fs.write")], WRITE_RULES)).toBe(15);
	});

	it("rewards fs.edit spans", () => {
		expect(scoreSpans([span("alef.command/fs.edit")], WRITE_RULES)).toBe(10);
	});
});

// ---------------------------------------------------------------------------
// schemaTokensEstimate flows through deriveturns
// ---------------------------------------------------------------------------

describe("deriveturns — schemaTokensEstimate", { tags: ["unit"] }, () => {
	function chatSpan(attrs: Record<string, unknown> = {}): SpanRecord {
		return span("chat claude-3-5-haiku", {
			"gen_ai.request.model": "claude-3-5-haiku",
			"gen_ai.usage.input_tokens": 1000,
			"gen_ai.usage.output_tokens": 100,
			...attrs,
		});
	}

	it("reads alef.schema_token_estimate from span attributes", () => {
		const spans = [chatSpan({ "alef.schema_token_estimate": 250 })];
		const turns = deriveturns(spans);
		expect(turns).toHaveLength(1);
		expect(turns[0]!.schemaTokensEstimate).toBe(250);
	});

	it("defaults to 0 when attribute is absent", () => {
		const turns = deriveturns([chatSpan()]);
		expect(turns[0]!.schemaTokensEstimate).toBe(0);
	});

	it("schemaFraction = schemaTokensEstimate / tokensIn", () => {
		const turns = deriveturns([chatSpan({ "alef.schema_token_estimate": 250 })]);
		const fraction = turns[0]!.schemaTokensEstimate / turns[0]!.tokensIn;
		expect(fraction).toBeCloseTo(0.25);
	});

	it("handles multiple turns independently", () => {
		const spans = [chatSpan({ "alef.schema_token_estimate": 300 }), chatSpan({ "alef.schema_token_estimate": 400 })];
		const turns = deriveturns(spans);
		expect(turns[0]!.schemaTokensEstimate).toBe(300);
		expect(turns[1]!.schemaTokensEstimate).toBe(400);
	});
});

describe("scoreSpans — attribute filter", { tags: ["unit"] }, () => {
	it("only scores spans matching attribute filter", () => {
		const rules = [{ match: "alef.command/fs.read", points: 5, attribute: { key: "alef.cache.hit", value: true } }];
		const spans = [
			span("alef.command/fs.read", { "alef.cache.hit": true }), // matches → +5
			span("alef.command/fs.read", { "alef.cache.hit": false }), // no match → 0
		];
		expect(scoreSpans(spans, rules)).toBe(5);
	});
});

describe("aggregateRunUsage", { tags: ["unit"] }, () => {
	it("sums tokens and cost from turns and averages tok/P from bus events", () => {
		const turns = deriveturns([
			span("chat m", {
				"gen_ai.request.model": "claude-haiku",
				"gen_ai.usage.input_tokens": 100,
				"gen_ai.usage.output_tokens": 20,
				"alef.estimated_cost_usd": 0.01,
			}),
			span("chat m", {
				"gen_ai.request.model": "claude-haiku",
				"gen_ai.usage.input_tokens": 50,
				"gen_ai.usage.output_tokens": 10,
				"alef.estimated_cost_usd": 0.005,
			}),
		]);
		const usage = aggregateRunUsage(turns, [
			{
				bus: "notification",
				event: "telemetry.progress.step",
				correlationId: "a",
				payload: { tokens: 10, progress: 2, tok_per_progress: 5 },
			},
			{
				bus: "notification",
				event: "telemetry.progress.step",
				correlationId: "b",
				payload: { tokens: 20, progress: 2, tok_per_progress: 10 },
			},
		]);
		expect(usage.tokensIn).toBe(150);
		expect(usage.tokensOut).toBe(30);
		expect(usage.costUsd).toBeCloseTo(0.015);
		expect(usage.model).toBe("claude-haiku");
		expect(usage.progressSteps).toBe(2);
		expect(usage.tokPerProgress).toBe(7.5);
	});

	it("codingUsageMetrics exposes scoreboard keys", () => {
		const turns = deriveturns([
			span("chat m", {
				"gen_ai.request.model": "m",
				"gen_ai.usage.input_tokens": 40,
				"gen_ai.usage.output_tokens": 10,
				"alef.estimated_cost_usd": 0.002,
			}),
		]);
		const usage = aggregateRunUsage(turns, []);
		const metrics = codingUsageMetrics({
			scenario: "x",
			turns,
			transcript: [],
			passed: true,
			totalEvents: 0,
			totalSpans: 0,
			cacheHits: 0,
			cacheMisses: 0,
			oae: 0,
			loopDetected: false,
			spans: [],
			durationMs: 1,
			avgSchemaFraction: 0,
			sendTimingsMs: [],
			timedOut: false,
			busEvents: [],
			...usage,
		});
		expect(metrics.tokens_total).toBe(50);
		expect(metrics.cost_usd).toBeCloseTo(0.002);
		expect(metrics.tok_per_progress).toBeNull();
		expect(metrics.progress_steps).toBe(0);
	});
});

describe("generateScoreboard — usage section", { tags: ["unit"] }, () => {
	it("renders usage/intensity for coding rows and plant table for plant rows", () => {
		const coding = buildRunRecord("claude-haiku", "test", [
			{
				id: "ToolUse_read",
				pass: true,
				score: 1,
				durationMs: 1200,
				costUsd: 0.01,
				kind: "coding",
				metrics: {
					tokens_in: 100,
					tokens_out: 20,
					tokens_total: 120,
					cost_usd: 0.01,
					turns: 2,
					progress_steps: 1,
					tok_per_progress: 4.5,
				},
			},
		]);
		const plant = buildRunRecord("scripted", "harness", [
			{
				id: "dot-circle",
				pass: true,
				score: 1,
				durationMs: 500,
				kind: "plant",
				metrics: {
					in_circle_ratio: 1,
					terminal_inside: 1,
					progress_steps: 2,
					tok_per_progress: 3,
					tool_errors: 0,
					survival_ticks: 5,
				},
			},
		]);
		const codingMd = generateScoreboard([coding]);
		expect(codingMd).toContain("Usage / Intensity");
		expect(codingMd).toContain("ToolUse_read");
		expect(codingMd).toContain("tok_per_progress");
		expect(codingMd).not.toContain("Plant Metrics");

		const plantMd = generateScoreboard([plant]);
		expect(plantMd).toContain("Plant Metrics");
		expect(plantMd).toContain("dot-circle");
		expect(plantMd).not.toContain("Usage / Intensity");
	});
});
