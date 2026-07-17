import { fetchModelsDev } from "./models-dev.js";
import { getModelRegistry } from "./llm-core.js";
import { mergeModelsDevEntries } from "./models-snapshot.js";

export {
	calculateCost,
	clampThinkingLevel,
	getModel,
	getModels,
	getProviders,
	getSupportedThinkingLevels,
	modelsAreEqual,
} from "./llm-core.js";

let _refreshed = false;

/** Fetch fresh model metadata from models.dev and merge into the registry. */
export async function refreshModelRegistry(): Promise<void> {
	if (_refreshed) return;
	_refreshed = true;
	const entries = await fetchModelsDev();
	if (entries.length > 0) mergeModelsDevEntries(getModelRegistry(), entries);
}
