import type {
	Api,
	Message,
	Model,
	ThinkingLevel,
	TokenUsage,
	ToolCallEnd,
	ToolCallStart,
} from "@dpopsuev/alef-organ-llm";
import { Cerebrum } from "@dpopsuev/alef-organ-llm";
import type { ToolDefinition } from "@dpopsuev/alef-spine";
import { ScriptedReasoner, step } from "@dpopsuev/alef-testkit";
import type { Args } from "./args.js";
import { resolveApiKey } from "./auth.js";
import type { AlefConfig } from "./config.js";

export interface ToolSlot {
	onToolStart: ((event: ToolCallStart) => void) | undefined;
	onToolEnd: ((event: ToolCallEnd) => void) | undefined;
	onTokenUsage: ((usage: TokenUsage) => void) | undefined;
	receiveTextChunk: ((chunk: string) => void) | undefined;
	receiveThinkingChunk: ((chunk: string) => void) | undefined;
}

type SerializedStep =
	| string
	| { kind: "reply"; text: string }
	| { kind: "toolCall"; call: { name: string; args: Record<string, unknown> }; reply: string }
	| { kind: "toolCalls"; calls: Array<{ name: string; args: Record<string, unknown> }>; reply: string };

function deserializeStep(s: SerializedStep): ReturnType<typeof step.reply> {
	if (typeof s === "string") return step.reply(s);
	if (s.kind === "reply") return step.reply(s.text);
	if (s.kind === "toolCall") return step.toolCall(s.call.name, s.call.args, s.reply);
	if (s.kind === "toolCalls") return step.toolCalls(s.calls, s.reply);
	return step.reply(String(s));
}

export interface LlmOrganOptions {
	model: Model<Api>;
	cfg: AlefConfig;
	args: Args;
	toolSlot: ToolSlot;
	thinkingState: { level: ThinkingLevel | undefined };
	prepareStep: (messages: Message[]) => Promise<Message[]>;
	onCheckpoint: ((messages: Message[], correlationId: string) => void) | undefined;
	getModel: () => Model<Api>;
	getSignal: () => AbortSignal | undefined;
	getTools: () => ToolDefinition[];
}

export function buildLlmOrgan(opts: LlmOrganOptions): Cerebrum | ScriptedReasoner {
	const scriptedRepliesEnv = process.env.ALEF_SCRIPTED_REPLIES;

	if (scriptedRepliesEnv) {
		return new ScriptedReasoner((JSON.parse(scriptedRepliesEnv) as SerializedStep[]).map(deserializeStep), {
			onToolStart: (event) => opts.toolSlot.onToolStart?.(event),
			onToolEnd: (event) => opts.toolSlot.onToolEnd?.(event),
			onResponseChunk: (chunk) => opts.toolSlot.receiveTextChunk?.(chunk),
		});
	}

	return new Cerebrum({
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
		onToolStart: (event) => opts.toolSlot.onToolStart?.(event),
		onToolEnd: (event) => opts.toolSlot.onToolEnd?.(event),
		onTokenUsage: (usage) => opts.toolSlot.onTokenUsage?.(usage),
		onResponseChunk: (chunk) => opts.toolSlot.receiveTextChunk?.(chunk),
		onThinkingChunk: (chunk) => opts.toolSlot.receiveThinkingChunk?.(chunk),
	});
}
