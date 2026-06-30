const PHASE_TIMEOUT_MS = 100;
import { ScriptedLlmAdapter } from "./scripted-llm.js";
import type { Api, Model, ThinkingLevel } from "@dpopsuev/alef-ai/types";
import type { Adapter, ToolDefinition } from "@dpopsuev/alef-kernel/adapter";
import { createAgentLoop } from "@dpopsuev/alef-reasoner";

export interface LlmBuildOptions {
	model: Model<Api>;
	getModel: () => Model<Api>;
	getSignal: () => AbortSignal | undefined;
	thinkingState: { level: ThinkingLevel | undefined };
	getApiKey?: (provider: string) => string | undefined;
	systemPrompt?: string;
	schemaResolver?: (toolName: string) => ToolDefinition | undefined;
	trackConcurrentOps?: boolean;
	llm?: {
		maxRetries?: number;
		maxRetryDelayMs?: number;
		timeoutMs?: number;
	};
}

export function buildLlm(opts: LlmBuildOptions): Adapter {
	const scriptedRepliesEnv = process.env.ALEF_SCRIPTED_REPLIES;

	if (scriptedRepliesEnv) {
		return new ScriptedLlmAdapter(JSON.parse(scriptedRepliesEnv) as string[]);
	}

	return createAgentLoop({
		model: opts.model,
		getModel: opts.getModel,
		getApiKey: opts.getApiKey ? () => opts.getApiKey!(opts.getModel().provider) : undefined,
		getThinking: () => opts.thinkingState.level,
		systemPrompt: opts.systemPrompt,
		maxRetries: opts.llm?.maxRetries,
		maxRetryDelayMs: opts.llm?.maxRetryDelayMs,
		timeoutMs: opts.llm?.timeoutMs,
		trackConcurrentOps: opts.trackConcurrentOps,
		getSignal: opts.getSignal,
		phaseTimeoutMs: PHASE_TIMEOUT_MS,
		schemaResolver: opts.schemaResolver,
	});
}
