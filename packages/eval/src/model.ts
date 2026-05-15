/**
 * Model configuration for real-LLM evaluation runs.
 *
 * Default: claude-sonnet-4-5 (best reasoning for coding scenarios).
 * Override: ALEF_EVAL_MODEL=<id> (must match a known model id below).
 * Skip: if no ANTHROPIC_API_KEY is set.
 */

import type { Api, Model } from "@dpopsuev/alef-ai";

export const SKIP_REAL_LLM = !process.env.ANTHROPIC_API_KEY;

function buildModel(id: string): Model<Api> {
	const base = {
		reasoning: false,
		input: ["text" as const],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
		api: "anthropic-messages" as Api,
		provider: "anthropic" as const,
		baseUrl: "https://api.anthropic.com",
	};

	const knownNames: Record<string, string> = {
		"claude-sonnet-4-5": "Claude Sonnet 4.5",
		"claude-haiku-4-5": "Claude Haiku 4.5",
		"claude-opus-4-5": "Claude Opus 4.5",
		"claude-3-7-sonnet-20250219": "Claude 3.7 Sonnet",
		"claude-3-5-haiku-20241022": "Claude 3.5 Haiku",
	};

	return { ...base, id, name: knownNames[id] ?? id };
}

const DEFAULT_MODEL_ID = "claude-sonnet-4-5";

export function getEvalModel(): Model<Api> {
	const id = process.env.ALEF_EVAL_MODEL ?? DEFAULT_MODEL_ID;
	return buildModel(id);
}
