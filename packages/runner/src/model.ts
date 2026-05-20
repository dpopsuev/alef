/**
 * Model resolution for the runner.
 *
 * Builds a Model<Api> from a model ID string using the full @dpopsuev/alef-ai
 * model registry and provider list. Supports all known providers via env vars.
 *
 * Format:
 *   provider/model-id   → explicit provider + model lookup in registry
 *   model-id            → scan all providers with credentials; first match wins
 *   ollama/model-id     → openai-completions at OLLAMA_HOST (not in registry)
 *
 * Provider credential detection uses getEnvApiKey() which covers all 15+ providers
 * (env vars, ADC for Vertex, IAM for Bedrock).
 *
 * Default model when nothing is specified: anthropic/claude-sonnet-4-5
 */

import {
	type Api,
	findEnvKeys,
	getEnvApiKey,
	getModels,
	getProviders,
	type KnownProvider,
	type Model,
} from "@dpopsuev/alef-ai";

const OLLAMA_BASE_URL = process.env.OLLAMA_HOST ?? "http://localhost:11434/v1";

/** Provider-ordered preference for auto-detection when no model is specified. */
const PROVIDER_PREFERENCE: KnownProvider[] = [
	"anthropic",
	"google",
	"openai",
	"amazon-bedrock",
	"google-vertex",
	"groq",
	"openrouter",
	"mistral",
	"xai",
	"cerebras",
	"deepseek",
	"fireworks",
	"together",
	"huggingface",
];

/** Default model per provider when auto-detecting. */
const DEFAULT_MODEL_PER_PROVIDER: Partial<Record<KnownProvider, string>> = {
	anthropic: "claude-sonnet-4-5",
	google: "gemini-2.5-pro",
	openai: "gpt-4o",
	"amazon-bedrock": "anthropic.claude-sonnet-4-5-20251101-v1:0",
	"google-vertex": "gemini-2.5-pro",
	groq: "llama-3.3-70b-versatile",
	openrouter: "anthropic/claude-sonnet-4-5",
	mistral: "mistral-large-latest",
	xai: "grok-3",
	cerebras: "llama-3.3-70b",
	deepseek: "deepseek-chat",
	fireworks: "accounts/fireworks/models/llama-v3p3-70b-instruct",
	together: "meta-llama/Llama-3-70b-chat-hf",
};

/**
 * Find a model in the registry by provider + model ID.
 * Returns undefined if not found — caller falls back to a synthetic model.
 */
function lookupModel(provider: string, modelId: string): Model<Api> | undefined {
	const providers = getProviders();
	if (!providers.includes(provider as KnownProvider)) return undefined;
	const models = getModels(provider as KnownProvider);
	return (models as Model<Api>[]).find((m) => m.id === modelId);
}

/**
 * Build a synthetic model object for providers/models not in the static registry
 * (e.g. Ollama local models, custom OpenRouter routes, future models).
 */
function syntheticModel(provider: string, modelId: string, api: Api, baseUrl: string): Model<Api> {
	return {
		id: modelId,
		name: modelId,
		api,
		provider,
		baseUrl,
		reasoning: false,
		input: ["text" as const],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	};
}

/**
 * Resolve a model ID string into a Model<Api>.
 *
 * Call this at startup after args are parsed and env vars are set.
 */
export function buildModel(id: string): Model<Api> {
	// Ollama: ollama/<name> — not in the static registry
	if (id.startsWith("ollama/")) {
		const modelId = id.slice("ollama/".length);
		return syntheticModel("ollama", modelId, "openai-completions", OLLAMA_BASE_URL);
	}

	// Explicit provider prefix: provider/model-id
	const slashIdx = id.indexOf("/");
	if (slashIdx !== -1) {
		const provider = id.slice(0, slashIdx);
		const modelId = id.slice(slashIdx + 1);
		return (
			lookupModel(provider, modelId) ?? syntheticModel(provider, modelId, inferApi(provider), inferBaseUrl(provider))
		);
	}

	// Bare model ID: scan registry across all providers
	const providers = getProviders();
	for (const provider of providers) {
		const models = getModels(provider);
		const found = (models as Model<Api>[]).find((m) => m.id === id);
		if (found) return found;
	}

	// Not in registry — assume anthropic (backward-compat with bare claude-* names)
	return syntheticModel("anthropic", id, "anthropic-messages", "https://api.anthropic.com");
}

/**
 * Infer the API adapter for a provider not in the registry.
 * Conservative fallback — openai-completions is the most widely compatible.
 */
function inferApi(provider: string): Api {
	if (provider === "anthropic") return "anthropic-messages";
	if (provider === "google" || provider === "google-vertex") return "google-ai";
	if (provider === "amazon-bedrock") return "bedrock-converse-stream";
	return "openai-completions";
}

function inferBaseUrl(provider: string): string {
	if (provider === "anthropic") return "https://api.anthropic.com";
	if (provider === "openai") return "https://api.openai.com/v1";
	if (provider === "openrouter") return "https://openrouter.ai/api/v1";
	return "";
}

/**
 * Auto-detect: find the first provider with env-based credentials and return
 * its default model. Used when no --model flag or ALEF_MODEL is set.
 */
export function autoDetectModel(): Model<Api> | undefined {
	// Anthropic-on-Vertex: project + region configured, no API key needed.
	if (hasAnthropicOnVertex() && !getEnvApiKey("anthropic")) {
		const defaultId = DEFAULT_MODEL_PER_PROVIDER.anthropic ?? "claude-sonnet-4-5";
		return (
			lookupModel("anthropic", defaultId) ??
			syntheticModel("anthropic", defaultId, "anthropic-messages", "https://api.anthropic.com")
		);
	}

	// Check preference list first
	for (const provider of PROVIDER_PREFERENCE) {
		const apiKey = getEnvApiKey(provider);
		if (!apiKey) continue;
		const defaultId = DEFAULT_MODEL_PER_PROVIDER[provider];
		if (!defaultId) continue;
		const model = lookupModel(provider, defaultId);
		if (model) return model;
		// Provider has credentials but model not in registry — synthesize
		return syntheticModel(provider, defaultId, inferApi(provider), inferBaseUrl(provider));
	}
	return undefined;
}

/**
 * True when Anthropic-on-Vertex is configured (project + region env vars set).
 * These models route through the Vertex partner endpoint without an API key.
 */
function hasAnthropicOnVertex(): boolean {
	const project =
		process.env.ANTHROPIC_VERTEX_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
	const region = process.env.CLOUD_ML_REGION || process.env.GOOGLE_CLOUD_LOCATION;
	return !!(project && region);
}

/**
 * Returns true if any supported provider credentials are detected.
 */
export function hasCredentials(): boolean {
	if (process.env.OLLAMA_HOST) return true;
	if (hasAnthropicOnVertex()) return true;

	for (const provider of getProviders()) {
		if (getEnvApiKey(provider)) return true;
	}
	return false;
}

/**
 * Return a human-readable summary of detected credentials for the warning message.
 */
export function detectedProviders(): string[] {
	const found: string[] = [];
	if (process.env.OLLAMA_HOST) found.push("ollama");
	if (hasAnthropicOnVertex()) found.push("anthropic (vertex)");
	for (const provider of getProviders()) {
		const keys = findEnvKeys(provider);
		if (keys?.length) found.push(`${provider} (${keys.join(", ")})`);
		else if (getEnvApiKey(provider)) found.push(provider); // ambient auth (ADC, IAM)
	}
	return found;
}
