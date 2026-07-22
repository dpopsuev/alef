import { traceEvent } from "@dpopsuev/alef-kernel/log";
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

let refreshedSuccessfully = false;
let inflightRefresh: Promise<void> | undefined;

/**
 * Fetch fresh model metadata from models.dev and merge into the registry.
 * Concurrent callers share one in-flight fetch. A failed or empty attempt
 * does not permanently block retries -- only success is sticky for the
 * lifetime of the process, matching fetchModelsDev's own disk-cache TTL.
 */
export async function refreshModelRegistry(): Promise<void> {
	if (refreshedSuccessfully) return;

	inflightRefresh ??= (async () => {
		try {
			traceEvent("models:refresh:start");
			const entries = await fetchModelsDev();
			if (entries.length === 0) {
				traceEvent("models:refresh:empty");
				return;
			}
			mergeModelsDevEntries(getModelRegistry(), entries);
			refreshedSuccessfully = true;
			traceEvent("models:refresh:done", { count: entries.length });
		} catch (err) {
			traceEvent("models:refresh:error", { err: String(err) });
		} finally {
			inflightRefresh = undefined;
		}
	})();

	return inflightRefresh;
}
