import type { Api, Message, Model, ThinkingLevel } from "@dpopsuev/alef-ai";
import type { Organ, ToolDefinition } from "@dpopsuev/alef-kernel";
import type { CerebrumEvent } from "@dpopsuev/alef-organ-llm";
import { createAgentLoop } from "@dpopsuev/alef-organ-llm";
import type { Args } from "./args.js";
import { resolveApiKey } from "./auth.js";
import type { AlefConfig } from "./config.js";
import { ScriptedLlmOrgan } from "./scripted-llm.js";

export interface LlmOrganOptions {
	model: Model<Api>;
	cfg: AlefConfig;
	args: Args;
	onEvent?: (event: CerebrumEvent) => void;
	thinkingState: { level: ThinkingLevel | undefined };
	prepareStep: (messages: Message[]) => Promise<Message[]>;
	onCheckpoint: ((messages: Message[], correlationId: string) => void) | undefined;
	getModel: () => Model<Api>;
	getSignal: () => AbortSignal | undefined;
	getTools: () => ToolDefinition[];
	getFullTools: () => readonly ToolDefinition[];
}

export function buildLlmOrgan(opts: LlmOrganOptions): Organ {
	const scriptedRepliesEnv = process.env.ALEF_SCRIPTED_REPLIES;

	if (scriptedRepliesEnv) {
		return new ScriptedLlmOrgan(JSON.parse(scriptedRepliesEnv) as string[], {
			onEvent: opts.onEvent,
		});
	}

	return createAgentLoop({
		model: opts.model,
		getModel: opts.getModel,
		getApiKey: () => resolveApiKey(opts.getModel().provider),
		getThinking: () => opts.thinkingState.level,
		maxRetries: opts.cfg.llm?.maxRetries,
		maxRetryDelayMs: opts.cfg.llm?.maxRetryDelayMs,
		timeoutMs: opts.cfg.llm?.timeoutMs,
		prepareStep: opts.prepareStep,
		onCheckpoint: opts.onCheckpoint,
		trackConcurrentOps: opts.args.serve !== undefined,
		getSignal: opts.getSignal,
		phaseTimeoutMs: 100,
		getTools: opts.getTools,
		getFullTools: opts.getFullTools,
		onEvent: opts.onEvent,
	});
}
