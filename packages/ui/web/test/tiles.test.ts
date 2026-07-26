import { describe, expect, it } from "vitest";
import {
	composeResourceTile,
	parseTileDefinition,
	resolveTileMetrics,
	type TileDefinition,
} from "../src/tiles/index.js";

const snapshot = {
	contractId: "meter.snapshot.v1",
	schemaVersion: 1,
	timestamp: 1_700_000_000_000,
	session: {
		elapsedMs: 65_000,
		turns: 8,
		tokensIn: 1_200,
		tokensOut: 300,
		tokensCacheRead: 700,
		tokensTotal: 1_500,
		estimatedCostUsd: 0.42,
	},
	tools: {
		totalCalls: 12,
		totalErrors: 2,
		errorRate: "16.7%",
		errorRatePercent: 16.7,
		successRatePercent: 83.3,
		p50Ms: 40,
		p95Ms: 230,
		p99Ms: 420,
	},
	topTools: [{ name: "fs.read", calls: 6, errors: 0, avgMs: 35, maxMs: 70, successRate: "100.0", successRatePercent: 100 }],
};

describe("declarative resource tiles", { tags: ["unit"] }, () => {
	it("composes different product and engineering tiles from one contract", () => {
		const product = composeResourceTile("product");
		const engineering = composeResourceTile("engineering");

		expect(product.contractId).toBe(snapshot.contractId);
		expect(engineering.contractId).toBe(snapshot.contractId);
		expect(product.title).toBe("Delivery efficiency");
		expect(engineering.title).toBe("Runtime reliability");
		expect(product.metrics.map((metric) => metric.path)).not.toEqual(
			engineering.metrics.map((metric) => metric.path),
		);
		expect(JSON.parse(JSON.stringify([product, engineering]))).toEqual([product, engineering]);
	});

	it("resolves approved metric bindings without executable tile code", () => {
		const values = resolveTileMetrics(composeResourceTile("engineering"), snapshot);
		expect(values).toEqual([
			{ label: "Tool errors", value: 2, format: "number" },
			{ label: "Error rate", value: 16.7, format: "percent" },
			{ label: "p95 latency", value: 230, format: "duration" },
			{ label: "p99 latency", value: 420, format: "duration" },
		]);
	});

	it("rejects components outside the trusted tile catalog", () => {
		const generated = composeResourceTile("product") as TileDefinition & { component: string };
		expect(() => parseTileDefinition({ ...generated, component: "arbitrary-script" })).toThrow(
			"invalid tile definition",
		);
	});
});
