/**
 * Prometheus metrics for production daemon agents.
 *
 * Bus middleware: subscribes to wildcard events and increments counters,
 * histograms, and gauges. Exposes via prom-client's default register.
 *
 * Wire: call setupMetrics(bus) after the agent bus is created.
 * Expose: GET /metrics on the daemon HTTP router.
 */

import type { Bus } from "@dpopsuev/alef-kernel/bus";
import { Counter, Gauge, Histogram, register } from "prom-client";

const tokensTotal = new Counter({
	name: "alef_tokens_total",
	help: "Total tokens consumed",
	labelNames: ["direction"] as const,
});

const costTotal = new Counter({
	name: "alef_cost_usd_total",
	help: "Total estimated cost in USD",
	labelNames: ["model"] as const,
});

const turnsTotal = new Counter({
	name: "alef_turns_total",
	help: "Total LLM turns",
	labelNames: ["status"] as const,
});

const toolCallsTotal = new Counter({
	name: "alef_tool_calls_total",
	help: "Total tool calls",
	labelNames: ["tool", "status"] as const,
});

const toolDuration = new Histogram({
	name: "alef_tool_duration_seconds",
	help: "Tool call duration in seconds",
	labelNames: ["tool"] as const,
	buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30, 60],
});

const turnDuration = new Histogram({
	name: "alef_turn_duration_seconds",
	help: "LLM turn duration in seconds",
	labelNames: ["model"] as const,
	buckets: [0.5, 1, 2, 5, 10, 30, 60, 120],
});

const contextFillRatio = new Gauge({
	name: "alef_context_fill_ratio",
	help: "Context window fill ratio (0-1)",
});

const activeToolCalls = new Gauge({
	name: "alef_active_tool_calls",
	help: "Number of currently active tool calls",
});

const progressTokens = new Counter({
	name: "alef_progress_tokens_total",
	help: "Tokens attributed on telemetry.progress.step events",
});

const progressDelta = new Counter({
	name: "alef_progress_delta_total",
	help: "Sum of Progress (P) from telemetry.progress.step when Gap shrinks",
});

const tokPerProgress = new Gauge({
	name: "alef_tok_per_progress",
	help: "Latest Token per Progress (tok/P) from telemetry.progress.step; NaN when P unavailable",
});

const outcomeTokPerProgress = new Gauge({
	name: "alef_outcome_tok_per_progress",
	help: "Latest outcome-level tok/P from telemetry.progress.outcome",
});

/** Subscribe to agent bus events and update Prometheus counters, histograms, and gauges. */
export function setupMetrics(bus: Bus): void {
	bus.notification.subscribe("llm.token-usage", (event) => {
		const p = event.payload;
		const usage = p.usage;
		if (!usage || typeof usage !== "object") return;
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowed by typeof check above
		const u = usage as Record<string, unknown>;

		if (typeof u.input === "number") tokensTotal.inc({ direction: "input" }, u.input);
		if (typeof u.output === "number") tokensTotal.inc({ direction: "output" }, u.output);
		if (typeof u.costUsd === "number") costTotal.inc({ model: "unknown" }, u.costUsd);
		if (typeof u.totalTokens === "number") {
			const window = 200_000;
			contextFillRatio.set(Math.min(u.totalTokens / window, 1));
		}
	});

	bus.notification.subscribe("llm.tool-start", (event) => {
		const p = event.payload;
		const name = typeof p.name === "string" ? p.name : "unknown";
		toolCallsTotal.inc({ tool: name, status: "started" });
		activeToolCalls.inc();
	});

	bus.notification.subscribe("llm.tool-end", (event) => {
		const p = event.payload;
		const name = typeof p.name === "string" ? p.name : "unknown";
		const ok = p.ok !== false;
		const elapsed = typeof p.elapsedMs === "number" ? p.elapsedMs : 0;
		toolCallsTotal.inc({ tool: name, status: ok ? "ok" : "error" });
		toolDuration.observe({ tool: name }, elapsed / 1000);
		activeToolCalls.dec();
	});

	bus.command.subscribe("llm.response", (event) => {
		const p = event.payload;
		const isError = typeof p.text === "string" && p.text.startsWith("LLM error:");
		turnsTotal.inc({ status: isError ? "error" : "ok" });
	});

	bus.notification.subscribe("llm.result", (event) => {
		const p = event.payload;
		const resp = p.response;
		if (!resp || typeof resp !== "object") return;
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowed by typeof check above
		const r = resp as Record<string, unknown>;
		const usage = r.usage;
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowed by typeof check
		if (usage && typeof usage === "object" && typeof (usage as Record<string, unknown>).totalTokens === "number") {
			turnDuration.observe({ model: "unknown" }, event.elapsed / 1000);
		}
	});

	bus.notification.subscribe("telemetry.progress.step", (event) => {
		const p = event.payload;
		const tokens = typeof p.tokens === "number" ? p.tokens : 0;
		progressTokens.inc(tokens);
		if (typeof p.progress === "number" && p.progress > 0) {
			progressDelta.inc(p.progress);
		}
		if (typeof p.tok_per_progress === "number") {
			tokPerProgress.set(p.tok_per_progress);
		}
	});

	bus.notification.subscribe("telemetry.progress.outcome", (event) => {
		const p = event.payload;
		if (typeof p.tok_per_progress === "number") {
			outcomeTokPerProgress.set(p.tok_per_progress);
		}
	});
}

/** Serialize all registered Prometheus metrics as text for the /metrics endpoint. */
export async function metricsHandler(): Promise<string> {
	return register.metrics();
}

export { register };
