import type { Api, Model, ModelThinkingLevel, Usage } from "../types.js";
import { buildRegistryFromSnapshot, fetchModelsDev, mergeModelsDevEntries } from "./models-dev.js";

const COST_PER_MILLION = 1_000_000;

const modelRegistry = buildRegistryFromSnapshot();

let _refreshed = false;

/** Fetch fresh model metadata from models.dev and merge into the registry. */
export async function refreshModelRegistry(): Promise<void> {
	if (_refreshed) return;
	_refreshed = true;
	const entries = await fetchModelsDev();
	if (entries.length > 0) mergeModelsDevEntries(modelRegistry, entries);
}

/** Look up a model by provider and ID. Returns undefined if not found. */
export function getModel(provider: string, modelId: string): Model<Api> | undefined {
	return modelRegistry.get(provider)?.get(modelId);
}

/** List all known provider names. */
export function getProviders(): string[] {
	return Array.from(modelRegistry.keys());
}

/** List all models for a provider. */
export function getModels(provider: string): Model<Api>[] {
	const models = modelRegistry.get(provider);
	return models ? Array.from(models.values()) : [];
}

/**
 *
 */
export function calculateCost<TApi extends Api>(model: Model<TApi>, usage: Usage): Usage["cost"] {
	usage.cost.input = (model.cost.input / COST_PER_MILLION) * usage.input;
	usage.cost.output = (model.cost.output / COST_PER_MILLION) * usage.output;
	usage.cost.cacheRead = (model.cost.cacheRead / COST_PER_MILLION) * usage.cacheRead;
	usage.cost.cacheWrite = (model.cost.cacheWrite / COST_PER_MILLION) * usage.cacheWrite;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
	return usage.cost;
}

const EXTENDED_THINKING_LEVELS: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

/**
 *
 */
export function getSupportedThinkingLevels<TApi extends Api>(model: Model<TApi>): ModelThinkingLevel[] {
	if (!model.reasoning) return ["off"];

	return EXTENDED_THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (level === "xhigh") return mapped !== undefined;
		return true;
	});
}

/**
 *
 */
export function clampThinkingLevel<TApi extends Api>(
	model: Model<TApi>,
	level: ModelThinkingLevel,
): ModelThinkingLevel {
	const availableLevels = getSupportedThinkingLevels(model);
	if (availableLevels.includes(level)) return level;

	const requestedIndex = EXTENDED_THINKING_LEVELS.indexOf(level);
	if (requestedIndex === -1) return availableLevels[0] ?? "off";

	for (let i = requestedIndex; i < EXTENDED_THINKING_LEVELS.length; i++) {
		const candidate = EXTENDED_THINKING_LEVELS[i]!;
		if (availableLevels.includes(candidate)) return candidate;
	}
	for (let i = requestedIndex - 1; i >= 0; i--) {
		const candidate = EXTENDED_THINKING_LEVELS[i]!;
		if (availableLevels.includes(candidate)) return candidate;
	}
	return availableLevels[0] ?? "off";
}

/**
 * Check if two models are equal by comparing both their id and provider.
 * Returns false if either model is null or undefined.
 */
export function modelsAreEqual<TApi extends Api>(
	a: Model<TApi> | null | undefined,
	b: Model<TApi> | null | undefined,
): boolean {
	if (!a || !b) return false;
	return a.id === b.id && a.provider === b.provider;
}
