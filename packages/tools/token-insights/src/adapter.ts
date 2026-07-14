/**
 * Token insights adapter — query and analyze token usage telemetry data.
 *
 * Provides tools for cost analysis, optimization, and usage attribution.
 */

import { defineAdapter, typedAction } from "@dpopsuev/alef-kernel/adapter";
import { withDisplay } from "@dpopsuev/alef-kernel/payload";
import {
	queryTokens,
	aggregateBy,
	topConsumers,
	timeSeries,
	cacheSavings,
} from "@dpopsuev/alef-session/token-query";
import { z } from "zod";

const MS_PER_HOUR = 3600000;
const MS_PER_DAY = 86400000;

/**
 * Create token insights adapter.
 */
export function createTokenInsights(_opts?: unknown) {
	return defineAdapter(
		"token-insights",
		{
			command: {
				"tokens.summary": typedAction(
					{
						name: "tokens.summary",
						description:
							"Show token usage summary: total tokens, cost, breakdown by adapter/tool/model, cache savings.",
						inputSchema: z.object({
							sessionId: z.string().optional().describe("Filter to specific session (default: all sessions)"),
							hours: z.number().optional().describe("Look back N hours (default: all time)"),
						}),
					},
					async (ctx) => {
						const startTime = ctx.payload.hours ? Date.now() - ctx.payload.hours * MS_PER_HOUR : undefined;
						const records = await queryTokens({
							sessionId: ctx.payload.sessionId,
							startTime,
						});

						if (records.length === 0) {
							return withDisplay({ records: [] }, { text: "No token usage data found.", mimeType: "text/plain" });
						}

						const total = records.reduce(
							(sum, r) => {
								sum.calls++;
								sum.tokensIn += r.tokens.in;
								sum.tokensOut += r.tokens.out;
								sum.cacheRead += r.tokens.cr;
								sum.totalCost += r.cost.total;
								return sum;
							},
							{ calls: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, totalCost: 0 },
						);

						const byAdapter = aggregateBy(records, "adapter");
						const byTool = aggregateBy(records, "tool");
						const byModel = aggregateBy(records, "model");
						const cache = cacheSavings(records);

						const lines = [
							`Total: ${total.calls} LLM calls, ${total.tokensIn + total.tokensOut} tokens, $${total.totalCost.toFixed(4)}`,
							`  Input: ${total.tokensIn} tokens`,
							`  Output: ${total.tokensOut} tokens`,
							`  Cache hits: ${cache.cacheHits} (${cache.tokensFromCache} tokens, saved $${cache.estimatedSavingsUsd.toFixed(4)})`,
							"",
							"Top adapters:",
							...topConsumers(byAdapter, 5).map(
								({ key, metrics }) =>
									`  ${key}: ${metrics.totalTokens} tokens ($${metrics.totalCost.toFixed(4)}, ${metrics.calls} calls)`,
							),
							"",
							"Top tools:",
							...topConsumers(byTool, 10).map(
								({ key, metrics }) =>
									`  ${key}: ${metrics.totalTokens} tokens ($${metrics.totalCost.toFixed(4)}, ${metrics.calls} calls)`,
							),
							"",
							"By model:",
							...topConsumers(byModel, 5).map(
								({ key, metrics }) =>
									`  ${key}: ${metrics.totalTokens} tokens ($${metrics.totalCost.toFixed(4)}, ${metrics.calls} calls)`,
							),
						];

						return withDisplay(
							{
								total,
								byAdapter: Object.fromEntries(byAdapter),
								byTool: Object.fromEntries(byTool),
								byModel: Object.fromEntries(byModel),
								cache,
							},
							{ text: lines.join("\n"), mimeType: "text/plain" },
						);
					},
				),

				"tokens.top-consumers": typedAction(
					{
						name: "tokens.top-consumers",
						description: "Identify top token consumers by adapter, tool, or model.",
						inputSchema: z.object({
							groupBy: z.enum(["adapter", "tool", "model"]).describe("Group results by this dimension"),
							limit: z.number().optional().default(10).describe("Number of top consumers to show"),
							sessionId: z.string().optional().describe("Filter to specific session"),
							hours: z.number().optional().describe("Look back N hours"),
						}),
					},
					async (ctx) => {
						const startTime = ctx.payload.hours ? Date.now() - ctx.payload.hours * MS_PER_HOUR : undefined;
						const records = await queryTokens({
							sessionId: ctx.payload.sessionId,
							startTime,
						});

						const aggregated = aggregateBy(records, ctx.payload.groupBy);
						const top = topConsumers(aggregated, ctx.payload.limit);

						const lines = [
							`Top ${ctx.payload.limit} consumers by ${ctx.payload.groupBy}:`,
							"",
							...top.map(
								({ key, metrics }, i) =>
									`${i + 1}. ${key}: ${metrics.totalTokens} tokens ($${metrics.totalCost.toFixed(4)}, ${metrics.calls} calls)`,
							),
						];

						return withDisplay(
							{ groupBy: ctx.payload.groupBy, consumers: top },
							{ text: lines.join("\n"), mimeType: "text/plain" },
						);
					},
				),

				"tokens.trends": typedAction(
					{
						name: "tokens.trends",
						description: "Show token usage trends over time (hourly or daily buckets).",
						inputSchema: z.object({
							bucket: z.enum(["hour", "day"]).describe("Time bucket size"),
							sessionId: z.string().optional().describe("Filter to specific session"),
							hours: z.number().optional().describe("Look back N hours"),
						}),
					},
					async (ctx) => {
						const startTime = ctx.payload.hours ? Date.now() - ctx.payload.hours * MS_PER_HOUR : undefined;
						const records = await queryTokens({
							sessionId: ctx.payload.sessionId,
							startTime,
						});

						const bucketMs = ctx.payload.bucket === "hour" ? MS_PER_HOUR : MS_PER_DAY;
						const series = timeSeries(records, bucketMs);

						const lines = [
							`Token usage trends (${ctx.payload.bucket}ly buckets):`,
							"",
							...Array.from(series.entries())
								.sort(([a], [b]) => a - b)
								.map(([timestamp, metrics]) => {
									const date = new Date(timestamp).toISOString().replace("T", " ").slice(0, 16);
									return `${date}: ${metrics.totalTokens} tokens ($${metrics.totalCost.toFixed(4)}, ${metrics.calls} calls)`;
								}),
						];

						return withDisplay(
							{ bucket: ctx.payload.bucket, series: Object.fromEntries(series) },
							{ text: lines.join("\n"), mimeType: "text/plain" },
						);
					},
				),

				"tokens.cache-analysis": typedAction(
					{
						name: "tokens.cache-analysis",
						description: "Analyze prompt caching effectiveness and cost savings.",
						inputSchema: z.object({
							sessionId: z.string().optional().describe("Filter to specific session"),
							hours: z.number().optional().describe("Look back N hours"),
						}),
					},
					async (ctx) => {
						const startTime = ctx.payload.hours ? Date.now() - ctx.payload.hours * MS_PER_HOUR : undefined;
						const records = await queryTokens({
							sessionId: ctx.payload.sessionId,
							startTime,
						});

						const cache = cacheSavings(records);
						const totalCalls = records.length;
						const hitRate = totalCalls > 0 ? (cache.cacheHits / totalCalls) * 100 : 0;

						const lines = [
							"Prompt cache analysis:",
							`  Cache hits: ${cache.cacheHits} / ${totalCalls} (${hitRate.toFixed(1)}%)`,
							`  Tokens from cache: ${cache.tokensFromCache}`,
							`  Estimated savings: $${cache.estimatedSavingsUsd.toFixed(4)}`,
							"",
							"Cache is 10x cheaper than input tokens. Higher hit rate = lower costs.",
							hitRate < 20
								? "⚠ Low cache hit rate. Consider enabling prompt caching in model config."
								: hitRate > 60
									? "✓ Good cache utilization!"
									: "Cache utilization is moderate.",
						];

						return withDisplay(
							{
								cacheHits: cache.cacheHits,
								totalCalls,
								hitRate,
								tokensFromCache: cache.tokensFromCache,
								estimatedSavings: cache.estimatedSavingsUsd,
							},
							{ text: lines.join("\n"), mimeType: "text/plain" },
						);
					},
				),

				"tokens.export": typedAction(
					{
						name: "tokens.export",
						description: "Export token usage data to JSON for external analysis.",
						inputSchema: z.object({
							sessionId: z.string().optional().describe("Filter to specific session"),
							hours: z.number().optional().describe("Look back N hours"),
							format: z.enum(["json", "csv"]).default("json").describe("Export format"),
						}),
					},
					async (ctx) => {
						const startTime = ctx.payload.hours ? Date.now() - ctx.payload.hours * MS_PER_HOUR : undefined;
						const records = await queryTokens({
							sessionId: ctx.payload.sessionId,
							startTime,
						});

						if (ctx.payload.format === "csv") {
							const header = "timestamp,session,correlation,adapter,tool,model,turn,round,tokens_in,tokens_out,cache_read,cache_write,cost";
							const rows = records.map(r => [
								new Date(r.ts).toISOString(),
								r.sid,
								r.cid,
								r.adapter ?? "",
								r.tool ?? "",
								r.model ?? "",
								r.turn ?? "",
								r.round ?? "",
								r.tokens.in,
								r.tokens.out,
								r.tokens.cr,
								r.tokens.cw,
								r.cost.total,
							].join(","));
							const csv = [header, ...rows].join("\n");
							return withDisplay(
								{ format: "csv", records: records.length },
								{ text: csv, mimeType: "text/plain" },
							);
						}

						const json = JSON.stringify(records, null, 2);
						return withDisplay(
							{ format: "json", records: records.length },
							{ text: json, mimeType: "text/plain" },
						);
					},
				),

				"tokens.optimize": typedAction(
					{
						name: "tokens.optimize",
						description: "Analyze token usage and provide optimization recommendations.",
						inputSchema: z.object({
							sessionId: z.string().optional().describe("Filter to specific session"),
							hours: z.number().optional().describe("Look back N hours"),
						}),
					},
					async (ctx) => {
						const startTime = ctx.payload.hours ? Date.now() - ctx.payload.hours * MS_PER_HOUR : undefined;
						const records = await queryTokens({
							sessionId: ctx.payload.sessionId,
							startTime,
						});

						if (records.length === 0) {
							return withDisplay({ recommendations: [] }, { text: "No data to analyze.", mimeType: "text/plain" });
						}

						const byTool = aggregateBy(records, "tool");
						const cache = cacheSavings(records);
						const totalCost = records.reduce((sum, r) => sum + r.cost.total, 0);
						const totalCalls = records.length;
						const cacheHitRate = (cache.cacheHits / totalCalls) * 100;

						const recommendations: string[] = [];

						// Cache optimization
						if (cacheHitRate < 20) {
							recommendations.push("LOW CACHE HIT RATE: Enable prompt caching to reduce costs by up to 90%");
						} else if (cacheHitRate < 40) {
							recommendations.push("MODERATE CACHE USAGE: Increase cache hit rate by structuring prompts consistently");
						}

						// Top consumers
						const topTools = topConsumers(byTool, 3);
						const topTool = topTools[0];
						if (topTool && topTool.metrics.totalTokens > totalCost * 0.3) {
							const totalTokens = records.reduce((sum, r) => sum + r.tokens.total, 0);
							recommendations.push(
								`HIGH CONCENTRATION: Tool '${topTool.key}' accounts for ${Math.round((topTool.metrics.totalTokens / totalTokens) * 100)}% of tokens. Consider optimizing its usage.`,
							);
						}

						// Model selection
						const byModel = aggregateBy(records, "model");
						const models = Array.from(byModel.entries());
						if (models.some(([name]) => name.includes("sonnet") || name.includes("opus"))) {
							const cheaper = models.filter(([name]) => name.includes("haiku"));
							if (cheaper.length === 0) {
								recommendations.push("COST SAVINGS: Consider using haiku model for simple tasks (10x cheaper than sonnet)");
							}
						}

						// Context bloat
						const avgTokensPerCall = records.reduce((sum, r) => sum + r.tokens.in, 0) / totalCalls;
						if (avgTokensPerCall > 50000) {
							recommendations.push(
								"CONTEXT BLOAT: Average input is " + Math.round(avgTokensPerCall) + " tokens. Review compaction strategy.",
							);
						}

						const lines = [
							"Token Usage Optimization Report:",
							"",
							`Analyzed ${totalCalls} LLM calls, $${totalCost.toFixed(4)} total cost`,
							`Cache hit rate: ${cacheHitRate.toFixed(1)}%`,
							"",
							"Recommendations:",
							...recommendations.map((r, i) => `${i + 1}. ${r}`),
							"",
							recommendations.length === 0 ? "Token usage looks well-optimized." : "",
						];

						return withDisplay(
							{ recommendations, metrics: { totalCost, totalCalls, cacheHitRate, avgTokensPerCall } },
							{ text: lines.join("\n"), mimeType: "text/plain" },
						);
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
			description:
				"Token insights — query token usage telemetry, analyze costs, identify top consumers, track trends, measure cache effectiveness.",
			directives: [
				"Use tokens.summary to get an overview of token usage, costs, and breakdown by adapter/tool/model.",
				"Use tokens.top-consumers to identify which adapters, tools, or models consume the most tokens.",
				"Use tokens.trends to analyze token usage patterns over time (hourly or daily).",
				"Use tokens.cache-analysis to measure prompt caching effectiveness and cost savings.",
				"Use tokens.export to export usage data as JSON or CSV for external analysis tools.",
				"Use tokens.optimize to get actionable recommendations for reducing token costs and improving efficiency.",
			],
		},
	);
}
