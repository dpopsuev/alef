import { buildLlm } from "@dpopsuev/alef-agent/build-llm";
import type { Api, Model, ThinkingLevel } from "@dpopsuev/alef-ai/types";
import type { Adapter, ToolDefinition } from "@dpopsuev/alef-kernel/adapter";
import type { Args } from "./args.js";
import { resolveApiKey } from "./auth.js";
import type { AlefConfig } from "./config.js";

export interface LlmAdapterOptions {
	model: Model<Api>;
	cfg: AlefConfig;
	args: Args;
	thinkingState: { level: ThinkingLevel | undefined };
	getModel: () => Model<Api>;
	getSignal: () => AbortSignal | undefined;
	schemaResolver?: (toolName: string) => ToolDefinition | undefined;
	systemPrompt?: string;
}

export function buildLlmAdapter(opts: LlmAdapterOptions): Adapter {
	return buildLlm({
		model: opts.model,
		getModel: opts.getModel,
		getSignal: opts.getSignal,
		thinkingState: opts.thinkingState,
		getApiKey: (provider) => resolveApiKey(provider),
		systemPrompt: opts.systemPrompt,
		schemaResolver: opts.schemaResolver,
		trackConcurrentOps: opts.args.serve !== undefined,
		llm: opts.cfg.llm,
	});
}
