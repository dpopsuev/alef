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
	const id = process.env.ALEF_EVAL_MODEL ?? "claude-sonnet-4-5";

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

	// Vertex AI — uses Google ADC or ANTHROPIC_VERTEX_PROJECT_ID
	const project = process.env.ANTHROPIC_VERTEX_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT ?? "";
	// CLOUD_ML_REGION=global is not a valid Vertex AI region; fall back to us-east5.
	const rawRegion = process.env.CLOUD_ML_REGION;
	const region = rawRegion && rawRegion !== "global" ? rawRegion : "us-east5";
	return {
		id,
		name: `${id} (Vertex)`,
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: `https://${region}-aiplatform.googleapis.com/v1/projects/${project}/locations/${region}/publishers/anthropic/models`,
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
