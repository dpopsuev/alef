import type {
	Adapter,
	DataAccessPolicy,
	DataAccessRequest,
	DataPrincipal,
	DataScope,
} from "@dpopsuev/alef-kernel/adapter";
import {
	checkDataAccess,
	defineAdapter,
	resolveAuthorizedData,
	typedAction,
} from "@dpopsuev/alef-kernel/adapter";
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

export const METER_SNAPSHOT_CONTRACT_ID = "meter.snapshot.v1";

export const METER_SNAPSHOT_SCHEMA = z.object({
	contractId: z.literal(METER_SNAPSHOT_CONTRACT_ID),
	schemaVersion: z.literal(1),
	timestamp: z.number().int().nonnegative(),
	session: z.object({
		elapsedMs: z.number().nonnegative(),
		turns: z.number().int().nonnegative(),
		tokensIn: z.number().nonnegative(),
		tokensOut: z.number().nonnegative(),
		tokensCacheRead: z.number().nonnegative(),
		tokensTotal: z.number().nonnegative(),
		estimatedCostUsd: z.number().nonnegative(),
	}),
	tools: z.object({
		totalCalls: z.number().int().nonnegative(),
		totalErrors: z.number().int().nonnegative(),
		errorRate: z.string(),
		errorRatePercent: z.number().min(0).max(PERCENT),
		successRatePercent: z.number().min(0).max(PERCENT),
		p50Ms: z.number().nonnegative(),
		p95Ms: z.number().nonnegative(),
		p99Ms: z.number().nonnegative(),
	}),
	topTools: z.array(
		z.object({
			name: z.string().min(1),
			calls: z.number().int().nonnegative(),
			errors: z.number().int().nonnegative(),
			avgMs: z.number().nonnegative(),
			maxMs: z.number().nonnegative(),
			successRate: z.string(),
			successRatePercent: z.number().min(0).max(PERCENT),
		}),
	).max(TOP_TOOLS_COUNT),
});

/** Stable resource snapshot shared by agent-side producers and presentation consumers. */
export type MeterSnapshot = z.infer<typeof METER_SNAPSHOT_SCHEMA>;

/** Host-owned identity and scope used to authorize resource projections. */
export interface ResourceMeterOptions {
	policy?: DataAccessPolicy;
	principal: DataPrincipal;
	scope: DataScope;
}

/** Create a resource meter with a versioned, access-controlled snapshot contract. */
export function createResourceMeter(options: ResourceMeterOptions): Adapter {
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
	function summary(): MeterSnapshot {
		const timestamp = Date.now();
		const elapsed = timestamp - startedAt;
		const sortedLatencies = [...latencies].sort((a, b) => a - b);
		const totalCalls = [...toolStats.values()].reduce((count, stats) => count + stats.calls, 0);
		const totalErrors = [...toolStats.values()].reduce((count, stats) => count + stats.errors, 0);
		const errorRatePercent = totalCalls > 0 ? (totalErrors / totalCalls) * PERCENT : 0;
		const topTools = [...toolStats.entries()]
			.sort(([, left], [, right]) => right.calls - left.calls)
			.slice(0, TOP_TOOLS_COUNT)
			.map(([name, stats]) => {
				const successRatePercent = stats.calls > 0 ? ((stats.calls - stats.errors) / stats.calls) * PERCENT : 0;
				return {
					name,
					calls: stats.calls,
					errors: stats.errors,
					avgMs: Math.round(stats.totalMs / stats.calls),
					maxMs: stats.maxMs,
					successRate: successRatePercent.toFixed(1),
					successRatePercent,
				};
			});

		return {
			contractId: METER_SNAPSHOT_CONTRACT_ID,
			schemaVersion: 1,
			timestamp,
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
				errorRate: `${errorRatePercent.toFixed(1)}%`,
				errorRatePercent,
				successRatePercent: PERCENT - errorRatePercent,
				p50Ms: percentile(sortedLatencies, P50),
				p95Ms: percentile(sortedLatencies, P95),
				p99Ms: percentile(sortedLatencies, P99),
			},
			topTools,
		};
	}

	const accessRequest: DataAccessRequest = {
		contractId: METER_SNAPSHOT_CONTRACT_ID,
		principal: options.principal,
		scope: options.scope,
	};
	const resolveSnapshot = () => resolveAuthorizedData(options.policy, accessRequest, summary);

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
						const s = resolveSnapshot();
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
			publishSchemas: { notification: { "meter.snapshot": METER_SNAPSHOT_SCHEMA } },
			directives: ["Use meter.summary to check resource usage, token consumption, and tool performance."],
			sources: [{ name: "signal-bus", kind: "memory" }],
			onMount(bus: Bus) {
				startedAt = Date.now();
				bus.notification.subscribe("*", (event: NotificationMessage) => {
					const payload = event.payload;
					let changed = false;
					if (event.type === "llm.token-usage") {
						// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- bus protocol: llm.token-usage payload shape is known
						const usage = payload.usage as { input?: number; output?: number; cacheRead?: number } | undefined;
						if (usage) {
							tokens.input += usage.input ?? 0;
							tokens.output += usage.output ?? 0;
							tokens.cacheRead += usage.cacheRead ?? 0;
						}
						turns++;
						changed = true;
					}
					if (event.type === "llm.tool-end") {
						const name = typeof payload.name === "string" ? payload.name : "unknown";
						const elapsedMs = typeof payload.elapsedMs === "number" ? payload.elapsedMs : 0;
						const ok = payload.ok !== false;
						recordToolEnd(name, elapsedMs, ok);
						changed = true;
					}
					if (changed && checkDataAccess(options.policy, accessRequest).allowed) {
						bus.notification.publish({
							type: "meter.snapshot",
							payload: summary(),
							correlationId: event.correlationId,
						});
					}
				});
			},
		},
	);
}
