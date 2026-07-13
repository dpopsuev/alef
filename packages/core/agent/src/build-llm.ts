import type { Api, Model, ThinkingLevel } from "@dpopsuev/alef-ai/types";
import type { Adapter, ToolDefinition } from "@dpopsuev/alef-kernel/adapter";
import { createAgentLoop, type StreamRule } from "@dpopsuev/alef-reasoner";
import { ScriptedLlmAdapter } from "./scripted-llm.js";

const PHASE_TIMEOUT_MS = 100;

/**
 *
 */
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
	/** Override stream rules (default: empty, or ALEF_STREAM_RULES JSON). */
	streamRules?: readonly StreamRule[];
}

/** Parse ALEF_STREAM_RULES JSON env into StreamRule[]; invalid/missing → []. */
export function parseStreamRulesEnv(raw: string | undefined = process.env.ALEF_STREAM_RULES): StreamRule[] {
	if (!raw?.trim()) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		const rules: StreamRule[] = [];
		for (const item of parsed) {
			if (!item || typeof item !== "object") continue;
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- JSON array element narrowed after typeof object check
			const record = item as Record<string, unknown>;
			const id = typeof record.id === "string" ? record.id : undefined;
			const pattern = typeof record.pattern === "string" ? record.pattern : undefined;
			const message = typeof record.message === "string" ? record.message : undefined;
			const on = record.on === "thinking" || record.on === "both" || record.on === "text" ? record.on : "text";
			if (!id || !pattern || !message) continue;
			rules.push({ id, pattern, on, message });
		}
		return rules;
	} catch {
		return [];
	}
}

/**
 *
 */
export function buildLlm(opts: LlmBuildOptions): Adapter {
	const scriptedRepliesEnv = process.env.ALEF_SCRIPTED_REPLIES;

	if (scriptedRepliesEnv) {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- JSON.parse returns unknown, narrowing to expected format
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
		streamRules: opts.streamRules ?? parseStreamRulesEnv(),
	});
}
