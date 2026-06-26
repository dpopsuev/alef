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

import type { AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "../types.js";
import type { AnthropicOptions } from "./anthropic.js";
import { streamAnthropic, streamSimpleAnthropic } from "./anthropic.js";

// ---------------------------------------------------------------------------
// Environment resolution — the match() predicate and stream setup both call
// this to decide whether Vertex is available.
// ---------------------------------------------------------------------------

// matchesAnthropicVertex is inlined in register-builtins.ts

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
