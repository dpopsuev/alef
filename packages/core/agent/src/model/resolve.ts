import { findEnvKeys, getEnvApiKey } from "@dpopsuev/alef-ai/env";
import { getModels, getProviders } from "@dpopsuev/alef-ai/models";
import type { Api, KnownProvider, Model } from "@dpopsuev/alef-ai/types";

/**
 *
 */
export interface ModelLogger {
	warn(msg: string): void;
	error(msg: string): void;
}

let _logger: ModelLogger = {
	warn: (msg) => process.stderr.write(`[model] warning: ${msg}\n`),
	error: (msg) => process.stderr.write(`[model] error: ${msg}\n`),
};

/**
 *
 */
export function setModelLogger(l: ModelLogger): void {
	_logger = l;
}

/**
 *
 */
export interface ModelResolutionInput {
	modelId: string | undefined;
	debug: boolean;
}

/**
 *
 */
export interface ModelConfig {
	model?: string;
	profile?: string;
	profiles?: Record<
		string,
		{
			providers?: string[];
			models?: string[];
			modelPatterns?: string[];
			defaultModel?: string;
			default?: string;
			tiers?: Record<string, string>;
		}
	>;
	llm?: { contextWindow?: number };
}

let _configProvider: () => ModelConfig = () => ({});
/**
 *
 */
export function setModelConfigProvider(fn: () => ModelConfig): void {
	_configProvider = fn;
}

const DEFAULT_CONTEXT_WINDOW = 128_000;
const OLLAMA_BASE_URL = process.env.OLLAMA_HOST ?? "http://localhost:11434/v1";

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
 *
 */
function lookupModel(provider: string, modelId: string): Model<Api> | undefined {
	const providers: readonly string[] = getProviders();
	if (!providers.includes(provider)) return undefined;
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- validated by includes() above
	const models = getModels(provider as KnownProvider);
	return (models as Model<Api>[]).find((m) => m.id === modelId);
}

/**
 *
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
		contextWindow: _configProvider().llm?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
		maxTokens: 8_192,
	};
}

/**
 *
 */
export function buildModel(id: string): Model<Api> {
	if (id.startsWith("ollama/")) {
		const modelId = id.slice("ollama/".length);
		return syntheticModel("ollama", modelId, "openai-completions", OLLAMA_BASE_URL);
	}

	const slashIdx = id.indexOf("/");
	if (slashIdx !== -1) {
		const provider = id.slice(0, slashIdx);
		const modelId = id.slice(slashIdx + 1);
		const catalogModel = lookupModel(provider, modelId);
		if (catalogModel) return catalogModel;

		const knownProviders: readonly string[] = getProviders();
		if (!knownProviders.includes(provider)) {
			_logger.warn(`unknown provider "${provider}" — using synthetic model for ${id}`);
		}
		const baseUrl = inferBaseUrl(provider);
		if (!baseUrl && provider !== "google" && provider !== "google-vertex" && provider !== "amazon-bedrock") {
			_logger.warn(`no base URL for provider "${provider}" — API calls may fail`);
		}
		return syntheticModel(provider, modelId, inferApi(provider), baseUrl);
	}

	const allProviders = getProviders();
	const matches: Array<{ provider: KnownProvider; model: Model<Api> }> = [];
	for (const provider of allProviders) {
		const models = getModels(provider);
		const found = (models as Model<Api>[]).find((m) => m.id === id);
		if (found) matches.push({ provider, model: found });
	}

	if (matches.length > 1) {
		const names = matches.map((m) => m.provider).join(", ");
		_logger.warn(`"${id}" found in multiple providers: ${names} — using ${matches[0].provider}`);
	}

	if (matches.length > 0) return matches[0].model;

	_logger.warn(`"${id}" not found in any provider catalog — creating synthetic model (typo?)`);
	return syntheticModel("anthropic", id, "anthropic-messages", "https://api.anthropic.com");
}

const PROVIDER_API_MAP: Record<string, Api> = {
	anthropic: "anthropic-messages",
	google: "google-generative-ai",
	"google-vertex": "google-vertex",
	"amazon-bedrock": "bedrock-converse-stream",
	mistral: "mistral-conversations",
	azure: "azure-openai-responses",
};

/**
 *
 */
function inferApi(provider: string): Api {
	return PROVIDER_API_MAP[provider] ?? "openai-completions";
}

const PROVIDER_BASE_URL: Record<string, string> = {
	anthropic: "https://api.anthropic.com",
	openai: "https://api.openai.com/v1",
	openrouter: "https://openrouter.ai/api/v1",
	mistral: "https://api.mistral.ai/v1",
	groq: "https://api.groq.com/openai/v1",
	deepseek: "https://api.deepseek.com/v1",
	xai: "https://api.x.ai/v1",
	cerebras: "https://api.cerebras.ai/v1",
	fireworks: "https://api.fireworks.ai/inference/v1",
	together: "https://api.together.xyz/v1",
	huggingface: "https://api-inference.huggingface.co/models",
};

/**
 *
 */
function inferBaseUrl(provider: string): string {
	return PROVIDER_BASE_URL[provider] ?? "";
}

/**
 *
 */
export function autoDetectModel(): Model<Api> | undefined {
	// Anthropic-on-Vertex: project + region configured, no API key needed.
	if (hasAnthropicOnVertex() && !getEnvApiKey("anthropic")) {
		const defaultId = DEFAULT_MODEL_PER_PROVIDER.anthropic;
		if (!defaultId) return undefined;
		return (
			lookupModel("anthropic", defaultId) ??
			syntheticModel("anthropic", defaultId, "anthropic-messages", "https://api.anthropic.com")
		);
	}

	for (const provider of PROVIDER_PREFERENCE) {
		const apiKey = getEnvApiKey(provider);
		if (!apiKey) continue;
		const defaultId = DEFAULT_MODEL_PER_PROVIDER[provider];
		if (!defaultId) continue;
		const model = lookupModel(provider, defaultId);
		if (model) return model;
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
		// eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty string env vars must fall through
		process.env.ANTHROPIC_VERTEX_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
	// eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty string env vars must fall through
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
 *
 */
function validateApiKey(model: Model<Api>): void {
	const provider = model.provider;
	if (provider === "ollama") return;
	if (hasAnthropicOnVertex() && provider === "anthropic") return;
	const apiKey = getEnvApiKey(provider);
	if (!apiKey) {
		const envVars = findEnvKeys(provider);
		const hint = envVars?.length ? envVars.join(" or ") : `${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`;
		_logger.warn(`no API key for provider "${provider}" — set ${hint}`);
	}
}

/**
 *
 */
export function resolveStartupModel(
	args: ModelResolutionInput,
	blueprintModelId: string | undefined,
	cfg: ModelConfig,
): Model<Api> {
	if (!hasCredentials()) {
		_logger.warn(
			"no LLM credentials detected. " +
				"Set an API key env var (e.g. ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY).",
		);
	} else if (args.debug) {
		_logger.warn(`detected providers: ${detectedProviders().join(", ")}`);
	}
	const resolvedId = args.modelId ?? blueprintModelId ?? cfg.model;
	if (resolvedId) {
		const model = buildModel(resolvedId);
		validateApiKey(model);
		return model;
	}
	const detected = autoDetectModel();
	if (detected) return detected;
	_logger.error(
		"no model configured. " +
			"Set one of: --model <id>, ALEF_MODEL env var, model: in config.yaml, " +
			"or configure a provider API key (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.).",
	);
	process.exit(1);
}

/**
 *
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
