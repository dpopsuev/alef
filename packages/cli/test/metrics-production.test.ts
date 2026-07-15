/**
 * Production-readiness: Prometheus /metrics scrape contract and label cardinality.
 */

import { InProcessBus, newCorrelationId } from "@dpopsuev/alef-kernel/bus";
import { describe, expect, it } from "vitest";
import { metricsHandler, setupMetrics } from "../src/boot/metrics.js";

/** Metric names that must appear in daemon scrape output. */
const REQUIRED_PROGRESS_SERIES = [
	"alef_progress_tokens_total",
	"alef_progress_delta_total",
	"alef_tok_per_progress",
	"alef_outcome_tok_per_progress",
] as const;

/** Allowed label keys per series (empty = no labels). */
const LABEL_ALLOWLIST: Record<string, readonly string[]> = {
	alef_tokens_total: ["direction"],
	alef_cost_usd_total: ["model"],
	alef_turns_total: ["status"],
	alef_tool_calls_total: ["tool", "status"],
	alef_tool_duration_seconds: ["tool"],
	alef_turn_duration_seconds: ["model"],
	alef_context_fill_ratio: [],
	alef_active_tool_calls: [],
	alef_progress_tokens_total: [],
	alef_progress_delta_total: [],
	alef_tok_per_progress: [],
	alef_outcome_tok_per_progress: [],
};

/** Parse `name{labels}` sample lines into name + label keys. */
function parseSampleLabels(body: string): Map<string, Set<string>> {
	const out = new Map<string, Set<string>>();
	for (const line of body.split("\n")) {
		if (!line || line.startsWith("#")) continue;
		const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)\{([^}]*)\}/.exec(line);
		if (!match) {
			const bare = /^([a-zA-Z_:][a-zA-Z0-9_:]*)\s/.exec(line);
			if (bare) {
				if (!out.has(bare[1]!)) out.set(bare[1]!, new Set());
			}
			continue;
		}
		const name = match[1]!;
		const keys = new Set<string>();
		for (const part of match[2]!.split(",")) {
			const key = part.split("=")[0]?.trim();
			if (key) keys.add(key);
		}
		const existing = out.get(name) ?? new Set();
		for (const key of keys) existing.add(key);
		out.set(name, existing);
	}
	return out;
}

describe("Prometheus production readiness", { tags: ["unit"] }, () => {
	it("exposes tok/P and progress series in OpenMetrics text", async () => {
		const bus = new InProcessBus().asBus();
		setupMetrics(bus);

		const correlationId = newCorrelationId();
		bus.notification.publish({
			type: "telemetry.progress.step",
			payload: { tokens: 30, progress: 6, tok_per_progress: 5 },
			correlationId,
		});
		bus.notification.publish({
			type: "telemetry.progress.outcome",
			payload: { tok_per_progress: 5, steps: 1, converged: true },
			correlationId,
		});

		const body = await metricsHandler();
		for (const name of REQUIRED_PROGRESS_SERIES) {
			expect(body, `missing series ${name}`).toContain(`# TYPE ${name}`);
			expect(body, `missing samples for ${name}`).toMatch(new RegExp(`^${name}(?:\\{|\\s)`, "m"));
		}
		expect(body).toMatch(/alef_tok_per_progress(?:\{[^}]*\})?\s+5\b/);
	});

	it("keeps label cardinality within the allow-list", async () => {
		const bus = new InProcessBus().asBus();
		setupMetrics(bus);
		const correlationId = newCorrelationId();

		for (const tool of ["fs.read", "fs.write", "shell.exec", "/abs/path/should-not-be-label"]) {
			bus.notification.publish({
				type: "llm.tool-start",
				payload: { name: tool },
				correlationId,
			});
			bus.notification.publish({
				type: "llm.tool-end",
				payload: { name: tool, ok: true, elapsedMs: 12 },
				correlationId,
			});
		}
		bus.notification.publish({
			type: "telemetry.progress.step",
			payload: {
				tokens: 10,
				progress: 1,
				tok_per_progress: 10,
				path: "/tmp/secret.ts",
			},
			correlationId,
		});

		const body = await metricsHandler();
		const labels = parseSampleLabels(body);

		for (const [name, allowed] of Object.entries(LABEL_ALLOWLIST)) {
			const seen = labels.get(name);
			if (!seen) continue;
			for (const key of seen) {
				expect(allowed, `${name} has unexpected label ${key}`).toContain(key);
			}
		}

		expect(body).not.toMatch(/alef_progress_[^\s]*\{[^}]*path=/);
		expect(body).not.toMatch(/alef_tok_per_progress\{[^}]*path=/);
	});

	it("progress gauges have no high-cardinality labels", async () => {
		const body = await metricsHandler();
		expect(body).not.toMatch(/alef_tok_per_progress\{/);
		expect(body).not.toMatch(/alef_outcome_tok_per_progress\{/);
		expect(body).not.toMatch(/alef_progress_tokens_total\{/);
		expect(body).not.toMatch(/alef_progress_delta_total\{/);
	});
});
