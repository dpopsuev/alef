import type { TileDefinition } from "./contracts.js";

const METER_CONTRACT_ID = "meter.snapshot.v1";

const PERSONA_TILES = {
	product: {
		id: "resource-product",
		title: "Delivery efficiency",
		metrics: [
			{ label: "Turns", path: "session.turns", format: "number" },
			{ label: "Estimated cost", path: "session.estimatedCostUsd", format: "currency" },
			{ label: "Tool calls", path: "tools.totalCalls", format: "number" },
			{ label: "Success rate", path: "tools.successRatePercent", format: "percent" },
		],
	},
	engineering: {
		id: "resource-engineering",
		title: "Runtime reliability",
		metrics: [
			{ label: "Tool errors", path: "tools.totalErrors", format: "number" },
			{ label: "Error rate", path: "tools.errorRatePercent", format: "percent" },
			{ label: "p95 latency", path: "tools.p95Ms", format: "duration" },
			{ label: "p99 latency", path: "tools.p99Ms", format: "duration" },
		],
	},
} as const;

export type ResourceTilePersona = keyof typeof PERSONA_TILES;

export function composeResourceTile(persona: ResourceTilePersona): TileDefinition {
	const selected = PERSONA_TILES[persona];
	return {
		schemaVersion: "alef.tile.v1",
		id: selected.id,
		title: selected.title,
		contractId: METER_CONTRACT_ID,
		component: "metric-grid",
		metrics: selected.metrics.map((metric) => ({ ...metric })),
	};
}
