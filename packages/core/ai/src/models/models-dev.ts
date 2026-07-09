import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "../types.js";
import { MODELS } from "./llm.generated.js";

const MODELS_DEV_URL = "https://models.dev/api.json";
const CACHE_TTL_MS = 3_600_000;

const CACHE_DIR = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "alef");
const CACHE_PATH = join(CACHE_DIR, "models-dev.json");

interface ModelsDevEntry {
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

/** Check whether the local cache file exists and is within TTL. */
function isCacheFresh(): boolean {
	try {
		const raw = readFileSync(CACHE_PATH, "utf-8");
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- JSON structure validated by typeof check below
		const data = JSON.parse(raw) as { fetchedAt?: number };
		return typeof data.fetchedAt === "number" && Date.now() - data.fetchedAt < CACHE_TTL_MS;
	} catch {
		return false;
	}
}

/** Read cached models.dev entries from disk. */
function readCache(): ModelsDevEntry[] | null {
	try {
		const raw = readFileSync(CACHE_PATH, "utf-8");
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- JSON structure validated by Array.isArray check below
		const data = JSON.parse(raw) as { entries?: ModelsDevEntry[] };
		return Array.isArray(data.entries) ? data.entries : null;
	} catch {
		return null;
	}
}

/** Persist fetched entries to local cache (best-effort). */
function writeCache(entries: ModelsDevEntry[]): void {
	try {
		mkdirSync(CACHE_DIR, { recursive: true });
		writeFileSync(CACHE_PATH, JSON.stringify({ fetchedAt: Date.now(), entries }));
	} catch {
		// cache write is best-effort
	}
}

const FETCH_TIMEOUT_MS = 5_000;

/** Fetch models.dev/api.json entries, using local cache when fresh. */
export async function fetchModelsDev(): Promise<ModelsDevEntry[]> {
	if (isCacheFresh()) {
		const cached = readCache();
		if (cached) return cached;
	}

	try {
		const res = await fetch(MODELS_DEV_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- models.dev returns a JSON array of model entries
		const entries = (await res.json()) as ModelsDevEntry[];
		writeCache(entries);
		return entries;
	} catch {
		const cached = readCache();
		if (cached) return cached;
		return [];
	}
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
