/**
 * GitHub Copilot strategy for the openai-completions wire format.
 *
 * Registered before the generic openai-completions strategy.
 * match(): model.provider === "github-copilot".
 *
 * Pre-computes the per-request Copilot dynamic headers (which depend on
 * context.messages) and injects them via options.headers before delegating
 * to streamOpenAICompletions. This removes the hasCopilotVisionInput +
 * buildCopilotDynamicHeaders import from openai-completions.ts.
 *
 * ALE-SPC-47 / ALE-TSK-365 — Strangler Fig extraction from openai-completions.ts.
 */

import type { Api, AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "../types.js";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./github-copilot-headers.js";
import type { OpenAICompletionsOptions } from "./openai-completions.js";
import { streamOpenAICompletions, streamSimpleOpenAICompletions } from "./openai-completions.js";

export function matchesGitHubCopilot(model: Model<Api>): boolean {
	return model.provider === "github-copilot";
}

export const streamGitHubCopilotCompletions = (
	model: Model<"openai-completions">,
	context: Context,
	options?: OpenAICompletionsOptions,
): AssistantMessageEventStream => {
	const hasImages = hasCopilotVisionInput(context.messages);
	const copilotHeaders = buildCopilotDynamicHeaders({ messages: context.messages, hasImages });
	return streamOpenAICompletions(model, context, {
		...options,
		headers: { ...options?.headers, ...copilotHeaders },
	});
};

export const streamSimpleGitHubCopilotCompletions = (
	model: Model<"openai-completions">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const hasImages = hasCopilotVisionInput(context.messages);
	const copilotHeaders = buildCopilotDynamicHeaders({ messages: context.messages, hasImages });
	return streamSimpleOpenAICompletions(model, context, {
		...options,
		headers: { ...(options as { headers?: Record<string, string> } | undefined)?.headers, ...copilotHeaders },
	} as SimpleStreamOptions);
};
