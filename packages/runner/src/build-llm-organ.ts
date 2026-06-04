import type { Api, Message, Model, ThinkingLevel } from "@dpopsuev/alef-ai";
import type { CerebrumEvent } from "@dpopsuev/alef-organ-llm";
import { Cerebrum } from "@dpopsuev/alef-organ-llm";
import type { ToolDefinition } from "@dpopsuev/alef-spine";
import { ScriptedReasoner, step } from "@dpopsuev/alef-testkit";
import type { Args } from "./args.js";
import { resolveApiKey } from "./auth.js";
import type { AlefConfig } from "./config.js";

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
	onEvent?: (event: CerebrumEvent) => void;
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
			onToolStart: (e) => opts.onEvent?.({ type: "tool-start", callId: e.callId, name: e.name, args: e.args }),
			onToolEnd: (e) =>
				opts.onEvent?.({
					type: "tool-end",
					callId: e.callId,
					elapsedMs: e.elapsedMs,
					ok: e.ok,
					display: e.display,
					displayKind: e.displayKind,
				}),
			onResponseChunk: (chunk) => opts.onEvent?.({ type: "chunk", text: chunk }),
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
		onEvent: opts.onEvent,
	});
}
