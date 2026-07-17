import type { Api, Model } from "../types.js";
import { MODELS } from "./llm.generated.js";

/** models.dev API entry shape used for registry merges. */
export interface ModelsDevEntry {
	id: string;
	name: string;
	reasoning?: boolean;
	tool_call?: boolean;
	limit?: { context?: number; output?: number };
	cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
	modalities?: { input?: string[] };
}

const PROVIDER_API: Record<string, Api> = {
	anthropic: "anthropic-messages",
	google: "google-generative-ai",
	"google-vertex": "google-vertex",
	"amazon-bedrock": "bedrock-converse-stream",
	mistral: "mistral-conversations",
	azure: "azure-openai-responses",
};

const PROVIDER_URL: Record<string, string> = {
	anthropic: "https://api.anthropic.com",
	openai: "https://api.openai.com/v1",
	openrouter: "https://openrouter.ai/api/v1",
	mistral: "https://api.mistral.ai/v1",
	groq: "https://api.groq.com/openai/v1",
	deepseek: "https://api.deepseek.com",
	fireworks: "https://api.fireworks.ai/inference/v1",
	together: "https://api.together.xyz/v1",
};

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8_192;

/** Map a models.dev entry to provider + Model, or null if unparseable. */
function mapEntry(entry: ModelsDevEntry): { provider: string; model: Model<Api> } | null {
	const slashIdx = entry.id.indexOf("/");
	if (slashIdx === -1) return null;

	const provider = entry.id.slice(0, slashIdx);
	const modelId = entry.id.slice(slashIdx + 1);

	const api = PROVIDER_API[provider] ?? "openai-completions";
	const baseUrl = PROVIDER_URL[provider] ?? "";
	const hasImage = entry.modalities?.input?.includes("image") ?? false;

	return {
		provider,
		model: {
			id: modelId,
			name: entry.name,
			api,
			provider,
			baseUrl,
			reasoning: entry.reasoning ?? false,
			input: hasImage ? ["text", "image"] : ["text"],
			cost: {
				input: entry.cost?.input ?? 0,
				output: entry.cost?.output ?? 0,
				cacheRead: entry.cost?.cache_read ?? 0,
				cacheWrite: entry.cost?.cache_write ?? 0,
			},
			contextWindow: entry.limit?.context ?? DEFAULT_CONTEXT_WINDOW,
			maxTokens: entry.limit?.output ?? DEFAULT_MAX_TOKENS,
		},
	};
}

/** Merge models.dev entries into the model registry, updating existing entries and adding new ones. */
export function mergeModelsDevEntries(
	registry: Map<string, Map<string, Model<Api>>>,
	entries: ModelsDevEntry[],
): void {
	for (const entry of entries) {
		const mapped = mapEntry(entry);
		if (!mapped) continue;

		let providerMap = registry.get(mapped.provider);
		if (!providerMap) {
			providerMap = new Map();
			registry.set(mapped.provider, providerMap);
		}

		const existing = providerMap.get(mapped.model.id);
		if (existing) {
			existing.contextWindow = mapped.model.contextWindow;
			existing.maxTokens = mapped.model.maxTokens;
			existing.cost = mapped.model.cost;
			existing.reasoning = mapped.model.reasoning;
		} else {
			providerMap.set(mapped.model.id, mapped.model);
		}
	}
}

/** Build the initial registry from the bundled snapshot. */
export function buildRegistryFromSnapshot(): Map<string, Map<string, Model<Api>>> {
	const registry = new Map<string, Map<string, Model<Api>>>();
	for (const [provider, models] of Object.entries(MODELS)) {
		const providerModels = new Map<string, Model<Api>>();
		for (const [id, model] of Object.entries(models)) {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- generated MODELS entries conform to Model<Api>
			providerModels.set(id, model as Model<Api>);
		}
		registry.set(provider, providerModels);
	}
	return registry;
}
