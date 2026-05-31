/**
 * Model configuration for real-LLM evaluation runs.
 *
 * Uses Anthropic API only — direct key or Vertex AI:
 *   ANTHROPIC_API_KEY            → direct Anthropic API
 *   ANTHROPIC_VERTEX_PROJECT_ID  → Anthropic via Google Vertex AI
 *
 * Override model id: ALEF_EVAL_MODEL=<id>
 * Skip: if neither credential is set.
 */

import type { Api, Model } from "@dpopsuev/alef-ai";

function hasAnthropicDirect(): boolean {
	return !!process.env.ANTHROPIC_API_KEY;
}

function hasAnthropicVertex(): boolean {
	return !!(process.env.ANTHROPIC_VERTEX_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT);
}

export const SKIP_REAL_LLM = !hasAnthropicDirect() && !hasAnthropicVertex();

export function getEvalModel(): Model<Api> {
	// On the direct Anthropic API "claude-sonnet-4-5" is an alias that resolves
	// to claude-sonnet-4-5-20250929. On Vertex AI the model path must include the
	// date stamp; bare "claude-sonnet-4-5" may silently resolve to the deprecated
	// claude-sonnet-4@20250514. Use the explicit Vertex ID when routing through Vertex.
	const defaultId = hasAnthropicDirect() ? "claude-sonnet-4-5" : "claude-sonnet-4-5@20250929";
	const id = process.env.ALEF_EVAL_MODEL ?? defaultId;

	if (hasAnthropicDirect()) {
		return {
			id,
			name: id,
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			...base(),
		};
	}

	// Vertex AI — uses Google ADC (ANTHROPIC_VERTEX_PROJECT_ID + CLOUD_ML_REGION).
	// The AnthropicVertex SDK builds the request path from env vars and ignores baseUrl.
	// Region defaults to us-east5 if CLOUD_ML_REGION is unset.
	return {
		id,
		name: `${id} (Vertex)`,
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "",
		...base(),
	};
}

function base() {
	return {
		reasoning: false,
		input: ["text" as const],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	};
}
