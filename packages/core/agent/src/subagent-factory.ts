const RANDOM_ID_RADIX = 36;
const RANDOM_ID_LENGTH = 10;
import { createAgentSession } from "@dpopsuev/alef-agent/create-agent-session";
import type { Api, Model } from "@dpopsuev/alef-ai/types";
import type { SubagentFactory } from "@dpopsuev/alef-engine/subagent-port";
import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import { createContextPipeline, type ContextPipeline } from "@dpopsuev/alef-kernel/context-assembly";
import { AgentSession } from "@dpopsuev/alef-session/agent";
import { resolveSubagentActor } from "./identity/actor.js";
import type { ActorRouteTable } from "./identity/routes.js";
import { buildModel } from "./model/index.js";

/**
 *
 */
export type LlmAdapterFactory = (opts: {
	model: Model<Api>;
	systemPrompt?: string;
	contextPipeline: ContextPipeline;
}) => Adapter;

/**
 *
 */
export interface SubagentSessionOptions {
	model: Model<Api>;
	baseSystemPrompt?: string;
	trackConcurrentOps?: boolean;
	forwardToolChunks?: boolean;
	parentSessionId?: string;
	boardId?: string;
	actorRoutes?: ActorRouteTable;
	llmFactory?: LlmAdapterFactory;
}

/**
 *
 */
export function buildSubagentFactory(opts: SubagentSessionOptions): SubagentFactory {
	return (callOpts) => {
		const { adapters, onChunk, onInnerEvent, systemPrompt: callSystemPrompt, modelOverride } = callOpts;
		const run = callOpts.run;
		const subSessionId = `${opts.parentSessionId ?? "sub"}_${Math.random().toString(RANDOM_ID_RADIX).slice(2, RANDOM_ID_LENGTH)}`;
		const discourseTopic = run?.discourseTopic;
		const discourseThread = run?.discourseThread;
		const discussion =
			discourseTopic && discourseThread
				? {
						home: {
							forumId: discourseTopic,
							topicId: discourseThread,
							topicTitle: discourseThread,
						},
						active: {
							forumId: discourseTopic,
							topicId: discourseThread,
							topicTitle: discourseThread,
						},
						subscriptions: [
							{
								discussion: {
									forumId: discourseTopic,
									topicId: discourseThread,
									topicTitle: discourseThread,
								},
								subscribedAt: Date.now(),
								mode: "participate" as const,
								auto: true,
							},
						],
					}
				: undefined;
		const actorSeed = run?.logicalAgentId ?? run?.taskId ?? subSessionId;
		const subActor = resolveSubagentActor(opts.parentSessionId ?? "sub", actorSeed, opts.boardId ?? "");

		const dateContext = `Date: ${new Date().toISOString().split("T")[0]}`;
		const systemPrompt =
			[dateContext, opts.baseSystemPrompt, callSystemPrompt].filter(Boolean).join("\n\n") || undefined;
		const resolvedModel = modelOverride ? buildModel(modelOverride) : opts.model;

		const contextPipeline = createContextPipeline(adapters);
		const llm = opts.llmFactory?.({ model: resolvedModel, systemPrompt, contextPipeline });

		let reply = "";
		let totalInputTokens = 0;
		let totalOutputTokens = 0;

		const runtime = createAgentSession({
			cwd: process.cwd(),
			model: resolvedModel,
			adapters,
			...(llm ? { llmAdapter: llm } : { systemPrompt }),
			contextPipeline,
			toolDisclosure: "full",
			onReply: (text) => {
				if (text) reply = text;
			},
		});
		const sessionObservers = new Set<Parameters<AgentSession["subscribe"]>[0]>();
		const tokenBudget = callOpts.tokenBudget;
		let budgetExceeded = false;

		onInnerEvent?.(subSessionId, "agent.identity", {
			color: subActor.color,
			address: subActor.address,
			modelId: resolvedModel.id,
		});

		void runtime.then(
			({ controller, observers }) => {
				observers.add((event) => {
					for (const observer of sessionObservers) observer(event);
					if (event.type === "token-usage") {
						const usage = event.usage;
						totalInputTokens += usage.input;
						totalOutputTokens += usage.output;
						if (tokenBudget && !budgetExceeded && totalInputTokens + totalOutputTokens >= tokenBudget) {
							budgetExceeded = true;
							controller.receive(
								"[system] Token budget reached. Wrap up now — summarize your findings and return your final answer. Do not start new tool calls.",
								"system",
							);
						}
						onInnerEvent?.(subSessionId, "subagent-token-usage", {
							callId: subSessionId,
							input: totalInputTokens,
							output: totalOutputTokens,
						});
					}
					if (onChunk) {
						if (event.type === "chunk") onChunk(event.text);
						else if (opts.forwardToolChunks && event.type === "tool-chunk") onChunk(event.text);
					}
					if (onInnerEvent && "callId" in event) {
						const payload: Record<string, unknown> = {};
						for (const [key, value] of Object.entries(event)) {
							if (key !== "type") payload[key] = value;
						}
						onInnerEvent(subSessionId, event.type, payload);
					}
				});
			},
			() => undefined,
		);

		opts.actorRoutes?.register(subActor.address, async (message, timeout) => {
			const { controller } = await runtime;
			await controller.send(message, "human", timeout);
		});

		const session = new AgentSession({
			state: {
				id: subSessionId,
				modelId: resolvedModel.id,
				contextWindow: resolvedModel.contextWindow,
				discussion,
			},
			send: async (text, _sender, timeoutMs) => {
				const { controller } = await runtime;
				await controller.send(text, "human", timeoutMs);
				return reply;
			},
			receive: (text) => {
				void runtime.then(({ controller }) => controller.receive(text, "human"), () => undefined);
			},
			dispose: () => {
				opts.actorRoutes?.unregister(subActor.address);
				void runtime.then((sessionRuntime) => sessionRuntime.dispose(), () => undefined);
			},
			observers: sessionObservers,
		});

		Object.defineProperty(session, "identity", {
			get: () => ({ color: subActor.color, address: subActor.address }),
		});
		Object.defineProperty(session, "tokenUsage", {
			get: () => ({ input: totalInputTokens, output: totalOutputTokens }),
		});

		return session;
	};
}
