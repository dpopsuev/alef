import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	aggregateBy,
	cacheSavings,
	queryTokens,
	timeSeries,
	topConsumers,
	type TokenRecord,
} from "../src/token-query.js";

function record(partial: Partial<TokenRecord> & Pick<TokenRecord, "sid" | "tokens" | "cost">): TokenRecord {
	return {
		ts: partial.ts ?? 1_000,
		cid: partial.cid ?? "c1",
		adapter: partial.adapter,
		tool: partial.tool,
		model: partial.model,
		...partial,
	};
}

describe("token-query pure aggregations", { tags: ["unit"] }, () => {
	const records: TokenRecord[] = [
		record({
			sid: "s1",
			adapter: "fs",
			tool: "fs.read",
			model: "haiku",
			tokens: { in: 100, out: 10, cr: 50, cw: 0, total: 110 },
			cost: { in: 0, out: 0, cr: 0.01, cw: 0, total: 0.02 },
		}),
		record({
			sid: "s1",
			ts: 2_000,
			adapter: "shell",
			tool: "shell.exec",
			model: "haiku",
			tokens: { in: 200, out: 20, cr: 0, cw: 0, total: 220 },
			cost: { in: 0, out: 0, cr: 0, cw: 0, total: 0.05 },
		}),
		record({
			sid: "s2",
			ts: 3_000,
			adapter: "fs",
			tool: "fs.read",
			model: "sonnet",
			tokens: { in: 50, out: 5, cr: 10, cw: 0, total: 55 },
			cost: { in: 0, out: 0, cr: 0.002, cw: 0, total: 0.01 },
		}),
	];

	it("aggregateBy adapter", () => {
		const by = aggregateBy(records, "adapter");
		expect(by.get("fs")?.calls).toBe(2);
		expect(by.get("fs")?.totalTokens).toBe(165);
		expect(by.get("shell")?.calls).toBe(1);
	});

	it("topConsumers sorts by totalTokens", () => {
		const top = topConsumers(aggregateBy(records, "tool"), 1);
		expect(top[0]?.key).toBe("shell.exec");
	});

	it("timeSeries buckets by ms", () => {
		const series = timeSeries(records, 1000);
		expect(series.size).toBe(3);
		expect(series.get(1000)?.calls).toBe(1);
	});

	it("cacheSavings counts hits and savings", () => {
		const savings = cacheSavings(records);
		expect(savings.cacheHits).toBe(2);
		expect(savings.tokensFromCache).toBe(60);
		expect(savings.estimatedSavingsUsd).toBeCloseTo(0.01 * 9 + 0.002 * 9);
	});
});

describe("queryTokens", { tags: ["unit"] }, () => {
	it("reads JSONL from an override telemetry root", async () => {
		const root = join(tmpdir(), `alef-token-query-${Date.now()}`);
		await mkdir(root, { recursive: true });
		const line = JSON.stringify(
			record({
				sid: "sess-a",
				adapter: "fs",
				tokens: { in: 1, out: 2, cr: 0, cw: 0, total: 3 },
				cost: { in: 0, out: 0, cr: 0, cw: 0, total: 0.1 },
			}),
		);
		await writeFile(join(root, "sess-a-tokens.jsonl"), `${line}\n`, "utf-8");

		const all = await queryTokens({ telemetryRoot: root });
		expect(all).toHaveLength(1);
		expect(all[0]?.sid).toBe("sess-a");

		const filtered = await queryTokens({ telemetryRoot: root, adapter: "missing" });
		expect(filtered).toHaveLength(0);
	});

	it("returns empty when root is missing", async () => {
		const records = await queryTokens({ telemetryRoot: join(tmpdir(), "no-such-alef-telemetry") });
		expect(records).toEqual([]);
	});
});
