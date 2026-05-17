/**
 * Model resolution for the runner.
 *
 * Builds a Model<Api> from a model ID string.
 * Supports Anthropic models via direct API or Vertex routing
 * (ANTHROPIC_VERTEX_PROJECT_ID + CLOUD_ML_REGION env vars).
 */

import type { Api, Model } from "@dpopsuev/alef-ai";

const KNOWN_MODEL_NAMES: Record<string, string> = {
	"claude-sonnet-4-5": "Claude Sonnet 4.5",
	"claude-haiku-4-5": "Claude Haiku 4.5",
	"claude-opus-4-5": "Claude Opus 4.5",
	"claude-3-7-sonnet-20250219": "Claude 3.7 Sonnet",
	"claude-3-5-haiku-20241022": "Claude 3.5 Haiku",
};

const OLLAMA_BASE_URL = process.env.OLLAMA_HOST ?? "http://localhost:11434/v1";

/**
 * Parse a model ID string into a Model<Api>.
 *
 * Routing:
 *   ollama/<name>    → openai-completions at OLLAMA_HOST (default: localhost:11434)
 *   anthropic/<name> → anthropic-messages (explicit)
 *   <name>           → anthropic-messages (default, backward-compat)
 *
 * Vertex AI routing activated by ANTHROPIC_VERTEX_PROJECT_ID + CLOUD_ML_REGION env vars
 * (handled inside organ-llm, not here).
 */
export function buildModel(id: string): Model<Api> {
	// Ollama: ollama/llama3, ollama/codestral, etc.
	if (id.startsWith("ollama/")) {
		const modelId = id.slice("ollama/".length);
		return {
			id: modelId,
			name: modelId,
			api: "openai-completions" as Api,
			provider: "ollama" as const,
			baseUrl: OLLAMA_BASE_URL,
			reasoning: false,
			input: ["text" as const],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8_192,
			maxTokens: 4_096,
		};
	}

	// Anthropic: explicit prefix or bare model name
	const anthropicId = id.startsWith("anthropic/") ? id.slice("anthropic/".length) : id;
	return {
		id: anthropicId,
		name: KNOWN_MODEL_NAMES[anthropicId] ?? anthropicId,
		api: "anthropic-messages" as Api,
		provider: "anthropic" as const,
		baseUrl: "https://api.anthropic.com",
		reasoning: false,
		input: ["text" as const],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	};
}

/**
 * Returns true if any supported provider credentials are detected.
 * The runner will still start without credentials — the first LLM call will fail.
 */
export function hasCredentials(): boolean {
	return Boolean(
		process.env.ANTHROPIC_API_KEY ||
			(process.env.ANTHROPIC_VERTEX_PROJECT_ID && process.env.CLOUD_ML_REGION) ||
			// Ollama is local — always has credentials if the server is running.
			process.env.OLLAMA_HOST !== undefined,
	);
}
