/**
 * Anthropic Vertex strategy — routes claude-* models through Google Vertex AI.
 *
 * Registered before the direct Anthropic strategy in register-builtins.ts.
 * match() self-selects when model.provider === "anthropic" AND Vertex env vars
 * (ANTHROPIC_VERTEX_PROJECT_ID / GOOGLE_CLOUD_PROJECT + CLOUD_ML_REGION) are set.
 *
 * Delegates to streamAnthropic with options.isVertex = true, which triggers the
 * AnthropicVertex SDK path inside anthropic.ts without env-var detection there.
 *
 * Strangler Fig extraction from anthropic.ts.
 */

import type { Api, AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "../types.js";
import type { AnthropicOptions } from "./anthropic.js";
import { streamAnthropic, streamSimpleAnthropic } from "./anthropic.js";

// ---------------------------------------------------------------------------
// Environment resolution — the match() predicate and stream setup both call
// this to decide whether Vertex is available.
// ---------------------------------------------------------------------------

function hasVertexConfig(): boolean {
	if (typeof process === "undefined") return false;
	const projectId =
		process.env.ANTHROPIC_VERTEX_PROJECT_ID?.trim() ||
		process.env.GOOGLE_CLOUD_PROJECT?.trim() ||
		process.env.GCLOUD_PROJECT?.trim();
	const region = process.env.CLOUD_ML_REGION?.trim() || process.env.GOOGLE_CLOUD_LOCATION?.trim();
	return Boolean(projectId && region);
}

/**
 * match() predicate for the Vertex strategy.
 * Registered alongside the direct Anthropic strategy; this one takes precedence
 * when Vertex credentials are present. Both share api="anthropic-messages".
 */
export function matchesAnthropicVertex(model: Model<Api>): boolean {
	return model.provider === "anthropic" && hasVertexConfig();
}

// ---------------------------------------------------------------------------
// Streaming — signal the Vertex path via options.isVertex and delegate.
// The AnthropicVertex client is created inside streamAnthropic's async IIFE.
// ---------------------------------------------------------------------------

export const streamAnthropicVertex = (
	model: Model<"anthropic-messages">,
	context: Context,
	options?: AnthropicOptions,
): AssistantMessageEventStream => streamAnthropic(model, context, { ...options, isVertex: true });

export const streamSimpleAnthropicVertex = (
	model: Model<"anthropic-messages">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream =>
	streamSimpleAnthropic(model, context, { ...options, isVertex: true } as SimpleStreamOptions & { isVertex: boolean });
