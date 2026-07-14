/**
 * Token usage query tools — aggregate and analyze token telemetry data.
 */

import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const TELEMETRY_ROOT = join(homedir(), ".alef", "telemetry");

/** One JSONL row of persisted LLM token usage. */
export interface TokenRecord {
	ts: number;
	sid: string;
	cid: string;
	adapter?: string;
	tool?: string;
	model?: string;
	turn?: number;
	round?: number;
	op?: string;
	tokens: {
		in: number;
		out: number;
		cr: number;
		cw: number;
		total: number;
	};
	cost: {
		in: number;
		out: number;
		cr: number;
		cw: number;
		total: number;
	};
}

/** Aggregated counters for a group of token records. */
export interface AggregatedMetrics {
	calls: number;
	tokensIn: number;
	tokensOut: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	totalCost: number;
}

/** Filters for reading token telemetry JSONL files. */
export interface QueryOptions {
	sessionId?: string;
	startTime?: number;
	endTime?: number;
	adapter?: string;
	tool?: string;
	model?: string;
	/** Override telemetry root (tests). Default: ~/.alef/telemetry */
	telemetryRoot?: string;
}

/**
 * Read all token records from a session telemetry file.
 */
async function readSessionTokens(sessionId: string, root: string): Promise<TokenRecord[]> {
	const path = join(root, `${sessionId}-tokens.jsonl`);
	try {
		const raw = await readFile(path, "utf-8");
		return raw
			.split("\n")
			.filter(Boolean)
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- JSONL deserialize
			.map((line) => JSON.parse(line) as TokenRecord);
	} catch {
		return [];
	}
}

/**
 * Read all token records matching query filters.
 */
export async function queryTokens(options: QueryOptions = {}): Promise<TokenRecord[]> {
	const root = options.telemetryRoot ?? TELEMETRY_ROOT;
	let records: TokenRecord[] = [];

	if (options.sessionId) {
		records = await readSessionTokens(options.sessionId, root);
	} else {
		try {
			const files = await readdir(root);
			for (const file of files) {
				if (!file.endsWith("-tokens.jsonl")) continue;
				const sessionId = file.replace("-tokens.jsonl", "");
				const sessionRecords = await readSessionTokens(sessionId, root);
				records.push(...sessionRecords);
			}
		} catch {
			return [];
		}
	}

	return records.filter((r) => {
		if (options.startTime && r.ts < options.startTime) return false;
		if (options.endTime && r.ts > options.endTime) return false;
		if (options.adapter && r.adapter !== options.adapter) return false;
		if (options.tool && r.tool !== options.tool) return false;
		if (options.model && r.model !== options.model) return false;
		return true;
	});
}

/**
 * Aggregate token records by a grouping key.
 */
export function aggregateBy(
	records: TokenRecord[],
	groupBy: "adapter" | "tool" | "model" | "session",
): Map<string, AggregatedMetrics> {
	const groups = new Map<string, AggregatedMetrics>();

	for (const record of records) {
		let key: string | undefined;
		if (groupBy === "adapter") key = record.adapter;
		if (groupBy === "tool") key = record.tool;
		if (groupBy === "model") key = record.model;
		if (groupBy === "session") key = record.sid;

		if (!key) continue;

		const existing = groups.get(key) ?? {
			calls: 0,
			tokensIn: 0,
			tokensOut: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			totalCost: 0,
		};

		existing.calls++;
		existing.tokensIn += record.tokens.in;
		existing.tokensOut += record.tokens.out;
		existing.cacheRead += record.tokens.cr;
		existing.cacheWrite += record.tokens.cw;
		existing.totalTokens += record.tokens.total;
		existing.totalCost += record.cost.total;

		groups.set(key, existing);
	}

	return groups;
}

/**
 * Get top N consumers by total tokens.
 */
export function topConsumers(
	aggregated: Map<string, AggregatedMetrics>,
	limit = 10,
): Array<{ key: string; metrics: AggregatedMetrics }> {
	return Array.from(aggregated.entries())
		.map(([key, metrics]) => ({ key, metrics }))
		.sort((a, b) => b.metrics.totalTokens - a.metrics.totalTokens)
		.slice(0, limit);
}

/**
 * Get token usage trends over time (hourly or daily buckets).
 */
export function timeSeries(
	records: TokenRecord[],
	bucketMs: number,
): Map<number, AggregatedMetrics> {
	const buckets = new Map<number, AggregatedMetrics>();

	for (const record of records) {
		const bucket = Math.floor(record.ts / bucketMs) * bucketMs;
		const existing = buckets.get(bucket) ?? {
			calls: 0,
			tokensIn: 0,
			tokensOut: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			totalCost: 0,
		};

		existing.calls++;
		existing.tokensIn += record.tokens.in;
		existing.tokensOut += record.tokens.out;
		existing.cacheRead += record.tokens.cr;
		existing.cacheWrite += record.tokens.cw;
		existing.totalTokens += record.tokens.total;
		existing.totalCost += record.cost.total;

		buckets.set(bucket, existing);
	}

	return buckets;
}

/**
 * Calculate cost savings from cache usage.
 */
export function cacheSavings(records: TokenRecord[]): {
	cacheHits: number;
	tokensFromCache: number;
	estimatedSavingsUsd: number;
} {
	let cacheHits = 0;
	let tokensFromCache = 0;

	for (const record of records) {
		if (record.tokens.cr > 0) {
			cacheHits++;
			tokensFromCache += record.tokens.cr;
		}
	}

	// Estimate savings: cache read is 10x cheaper than input tokens
	const estimatedSavingsUsd = records.reduce((sum, r) => {
		const CACHE_SAVINGS_MULTIPLIER = 9;
		return sum + r.cost.cr * CACHE_SAVINGS_MULTIPLIER; // 90% savings on cached tokens
	}, 0);

	return { cacheHits, tokensFromCache, estimatedSavingsUsd };
}
