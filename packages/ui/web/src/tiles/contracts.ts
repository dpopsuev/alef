import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";

const MetricBindingSchema = Type.Object(
	{
		label: Type.String({ minLength: 1, maxLength: 80 }),
		path: Type.String({ minLength: 1, pattern: "^[A-Za-z][A-Za-z0-9]*(\\.[A-Za-z][A-Za-z0-9]*)*$" }),
		format: Type.Union([
			Type.Literal("number"),
			Type.Literal("currency"),
			Type.Literal("percent"),
			Type.Literal("duration"),
		]),
	},
	{ additionalProperties: false },
);

export const TileDefinitionSchema = Type.Object(
	{
		schemaVersion: Type.Literal("alef.tile.v1"),
		id: Type.String({ minLength: 1, maxLength: 80 }),
		title: Type.String({ minLength: 1, maxLength: 120 }),
		contractId: Type.String({ minLength: 1, maxLength: 120 }),
		component: Type.Literal("metric-grid"),
		metrics: Type.Array(MetricBindingSchema, { minItems: 1, maxItems: 6 }),
	},
	{ additionalProperties: false },
);

export type TileDefinition = Static<typeof TileDefinitionSchema>;
export type MetricBinding = Static<typeof MetricBindingSchema>;
export interface TileInstance {
	readonly definition: TileDefinition;
	readonly data: unknown;
}
export interface ResolvedMetric {
	readonly label: string;
	readonly value: string | number;
	readonly format: MetricBinding["format"];
}

const tileDefinitionValidator = Compile(TileDefinitionSchema);

export function parseTileDefinition(input: unknown): TileDefinition {
	if (!tileDefinitionValidator.Check(input)) throw new Error("invalid tile definition");
	return input;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPath(data: unknown, path: string): unknown {
	let current = data;
	for (const segment of path.split(".")) {
		if (!isRecord(current) || !(segment in current)) throw new Error(`tile metric path not found: ${path}`);
		current = current[segment];
	}
	return current;
}

export function resolveTileMetrics(definitionInput: unknown, data: unknown): ResolvedMetric[] {
	const definition = parseTileDefinition(definitionInput);
	if (!isRecord(data) || data.contractId !== definition.contractId) {
		throw new Error(`tile contract mismatch: expected ${definition.contractId}`);
	}
	return definition.metrics.map((metric) => {
		const value = readPath(data, metric.path);
		if (typeof value !== "string" && typeof value !== "number") {
			throw new Error(`tile metric is not scalar: ${metric.path}`);
		}
		return { label: metric.label, value, format: metric.format };
	});
}
