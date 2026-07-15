/**
 * Model configuration for real-LLM evaluation runs.
 *
 * Uses the shared env model policy from @dpopsuev/alef-agent/model.
 * Override: ALEF_EVAL_MODEL=<id>
 * Skip: when hasCredentials() is false.
 */

import { hasCredentials, resolveEnvModel } from "@dpopsuev/alef-agent/model";
import type { Api, Model } from "@dpopsuev/alef-ai/types";

export const SKIP_REAL_LLM = !hasCredentials();

/**
 *
 */
export function getEvalModel(): Model<Api> {
	return resolveEnvModel({
		modelId: process.env.ALEF_EVAL_MODEL,
		onMissing: "throw",
	});
}
