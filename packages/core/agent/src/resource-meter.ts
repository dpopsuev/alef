import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import { defineAdapter, typedAction } from "@dpopsuev/alef-kernel/adapter";
import type { Bus, NotificationMessage } from "@dpopsuev/alef-kernel/bus";
import { withDisplay } from "@dpopsuev/alef-kernel/payload";
import { z } from "zod";

interface ToolStats {
	calls: number;
	errors: number;
	totalMs: number;
	maxMs: number;
}

const P50 = 50;
const P95 = 95;
const P99 = 99;
const TOP_TOOLS_COUNT = 10;
const PERCENT = 100;
const COST_PRECISION = 10000;
const MS_PER_SECOND = 1000;

/**
 *
 */
export function createResourceMeter(): Adapter {
	const tokens = { input: 0, output: 0, cacheRead: 0 };
	const cost = 0;
	let turns = 0;
	let startedAt = Date.now();
	const toolStats = new Map<string, ToolStats>();
	const latencies: number[] = [];

	/**
	 *
	 */
	function recordToolEnd(name: string, elapsedMs: number, ok: boolean) {
		const existing = toolStats.get(name) ?? { calls: 0, errors: 0, totalMs: 0, maxMs: 0 };
		existing.calls++;
		if (!ok) existing.errors++;
		existing.totalMs += elapsedMs;
		if (elapsedMs > existing.maxMs) existing.maxMs = elapsedMs;
		toolStats.set(name, existing);
		latencies.push(elapsedMs);
	}

	/**
	 *
	 */
	function percentile(sorted: number[], p: number): number {
		if (sorted.length === 0) return 0;
		const idx = Math.ceil((p / PERCENT) * sorted.length) - 1;
		return sorted[Math.max(0, idx)]!;
	}

	/**
	 *
	 */
	function summary() {
		const elapsed = Date.now() - startedAt;
		const sortedLatencies = [...latencies].sort((a, b) => a - b);
		const totalCalls = [...toolStats.values()].reduce((n, s) => n + s.calls, 0);
		const totalErrors = [...toolStats.values()].reduce((n, s) => n + s.errors, 0);
		const topTools = [...toolStats.entries()]
			.sort(([, a], [, b]) => b.calls - a.calls)
			.slice(0, TOP_TOOLS_COUNT)
			.map(([name, s]) => ({
				name,
				calls: s.calls,
				errors: s.errors,
				avgMs: Math.round(s.totalMs / s.calls),
				maxMs: s.maxMs,
				successRate: s.calls > 0 ? (((s.calls - s.errors) / s.calls) * PERCENT).toFixed(1) : "N/A",
			}));

		return {
			session: {
				elapsedMs: elapsed,
				turns,
				tokensIn: tokens.input,
				tokensOut: tokens.output,
				tokensCacheRead: tokens.cacheRead,
				tokensTotal: tokens.input + tokens.output,
				estimatedCostUsd: Math.round(cost * COST_PRECISION) / COST_PRECISION,
			},
			tools: {
				totalCalls,
				totalErrors,
				errorRate: totalCalls > 0 ? `${((totalErrors / totalCalls) * PERCENT).toFixed(1)}%` : "0%",
				p50Ms: percentile(sortedLatencies, P50),
				p95Ms: percentile(sortedLatencies, P95),
				p99Ms: percentile(sortedLatencies, P99),
			},
			topTools,
		};
	}

	return defineAdapter(
		"meter",
		{
			command: {
				"meter.summary": typedAction(
					{
						name: "meter.summary",
						description: "Show resource usage: tokens, cost, tool call stats, latency percentiles.",
						inputSchema: z.object({}),
					},
					async () => {
						await Promise.resolve();
						const s = summary();
						const lines = [
							`Session: ${s.session.turns} turns, ${(s.session.elapsedMs / MS_PER_SECOND).toFixed(0)}s`,
							`Tokens: ${s.session.tokensIn} in + ${s.session.tokensOut} out = ${s.session.tokensTotal} (cache read: ${s.session.tokensCacheRead})`,
							`Cost: $${s.session.estimatedCostUsd}`,
							`Tools: ${s.tools.totalCalls} calls, ${s.tools.errorRate} error rate`,
							`Latency: p50=${s.tools.p50Ms}ms p95=${s.tools.p95Ms}ms p99=${s.tools.p99Ms}ms`,
							"",
							...s.topTools.map(
								(t) =>
									`  ${t.name}: ${t.calls} calls (${t.successRate}% ok, avg ${t.avgMs}ms, max ${t.maxMs}ms)`,
							),
						];
						return withDisplay(s, { text: lines.join("\n"), mimeType: "text/plain" });
					},
				),
			},
			event: {
				"adapter.loaded": {
					handle() {
						return Promise.resolve();
					},
				},
			},
		},
		{
			description: "Resource meter — tracks tokens, cost, latency, tool success rates across the session.",
			directives: ["Use meter.summary to check resource usage, token consumption, and tool performance."],
			sources: [{ name: "signal-bus", kind: "memory" }],
			onMount(bus: Bus) {
				startedAt = Date.now();
				bus.notification.subscribe("*", (event: NotificationMessage) => {
					const p = event.payload;
					if (event.type === "llm.token-usage") {
						// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- bus protocol: llm.token-usage payload shape is known
						const usage = p.usage as { input?: number; output?: number; cacheRead?: number } | undefined;
						if (usage) {
							tokens.input += usage.input ?? 0;
							tokens.output += usage.output ?? 0;
							tokens.cacheRead += usage.cacheRead ?? 0;
						}
						turns++;
					}
					if (event.type === "llm.tool-end") {
						const name = typeof p.name === "string" ? p.name : "unknown";
						const elapsedMs = typeof p.elapsedMs === "number" ? p.elapsedMs : 0;
						const ok = p.ok !== false;
						recordToolEnd(name, elapsedMs, ok);
					}
				});
			},
		},
	);
}
