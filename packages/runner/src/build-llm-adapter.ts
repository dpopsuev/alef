import type { Adapter, ToolDefinition } from "@dpopsuev/alef-kernel";
import type { Api, Model, ThinkingLevel } from "@dpopsuev/alef-llm";

import { createAgentLoop } from "@dpopsuev/alef-reasoner";
import type { Args } from "./args.js";
import { resolveApiKey } from "./auth.js";
import type { AlefConfig } from "./config.js";
import { ScriptedLlmAdapter } from "./scripted-llm.js";

export interface LlmAdapterOptions {
	model: Model<Api>;
	cfg: AlefConfig;
	args: Args;
	thinkingState: { level: ThinkingLevel | undefined };

	getModel: () => Model<Api>;
	getSignal: () => AbortSignal | undefined;
	schemaResolver?: (toolName: string) => ToolDefinition | undefined;
	/** System prompt (directives) injected into every LLM call. */
	systemPrompt?: string;
}

export function buildLlmAdapter(opts: LlmAdapterOptions): Adapter {
	const scriptedRepliesEnv = process.env.ALEF_SCRIPTED_REPLIES;

	if (scriptedRepliesEnv) {
		return new ScriptedLlmAdapter(JSON.parse(scriptedRepliesEnv) as string[]);
	}

	return createAgentLoop({
		model: opts.model,
		getModel: opts.getModel,
		getApiKey: () => resolveApiKey(opts.getModel().provider),
		getThinking: () => opts.thinkingState.level,
		systemPrompt: opts.systemPrompt,
		maxRetries: opts.cfg.llm?.maxRetries,
		maxRetryDelayMs: opts.cfg.llm?.maxRetryDelayMs,
		timeoutMs: opts.cfg.llm?.timeoutMs,
		trackConcurrentOps: opts.args.serve !== undefined,
		getSignal: opts.getSignal,
		phaseTimeoutMs: 100,
		schemaResolver: opts.schemaResolver,
	});
}
