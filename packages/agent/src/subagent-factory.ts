import type { SubagentFactory } from "@dpopsuev/alef-blueprint";
import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import { createContextAssemblyPipeline } from "@dpopsuev/alef-kernel/pipeline";
import type { Api, Model } from "@dpopsuev/alef-llm";
import { createAgentLoop } from "@dpopsuev/alef-reasoner";
import type { Transcript } from "@dpopsuev/alef-runtime";
import { AgentSession } from "@dpopsuev/alef-session";
import { assembleAgentServer } from "./assemble.js";
import { resolveSubagentActor } from "./identity/actor.js";
import type { ActorRouteTable } from "./identity/routes.js";
import { buildModel } from "./model/index.js";

export type LlmAdapterFactory = (opts: { model: Model<Api>; systemPrompt?: string }) => Adapter;

const defaultLlmFactory: LlmAdapterFactory = (opts) =>
	createAgentLoop({ model: opts.model, systemPrompt: opts.systemPrompt, phaseTimeoutMs: 100 });

export interface SubagentSessionOptions {
	model: Model<Api>;
	baseSystemPrompt?: string;
	trackConcurrentOps?: boolean;
	forwardToolChunks?: boolean;
	parentSessionId?: string;
	boardId?: string;
	actorRoutes?: ActorRouteTable;
	transcript?: Transcript;
	llmFactory?: LlmAdapterFactory;
}

export function buildSubagentFactory(opts: SubagentSessionOptions): SubagentFactory {
	return (callOpts) => {
		const { adapters, onChunk, onInnerEvent, systemPrompt: callSystemPrompt, modelOverride } = callOpts;
		const subId = `${opts.parentSessionId ?? "sub"}_${Math.random().toString(36).slice(2, 10)}`;
		const subActor = resolveSubagentActor(opts.parentSessionId ?? "sub", subId, opts.boardId ?? "");

		const dateContext = `Date: ${new Date().toISOString().split("T")[0]}`;
		const systemPrompt =
			[dateContext, opts.baseSystemPrompt, callSystemPrompt].filter(Boolean).join("\n\n") || undefined;
		const resolvedModel = modelOverride ? buildModel(modelOverride) : opts.model;

		const llmFactory = opts.llmFactory ?? defaultLlmFactory;
		const llm = llmFactory({ model: resolvedModel, systemPrompt });

		const pipeline = createContextAssemblyPipeline();

		let reply = "";
		let totalInputTokens = 0;
		let totalOutputTokens = 0;

		const server = assembleAgentServer({
			llm,
			adapters,
			pipeline,
			onReply: (text) => {
				if (text) reply = text;
			},
			...(opts.transcript && { transcript: { store: opts.transcript, topic: "subagents", thread: subId } }),
		});

		const { agent, controller, observers } = server;
		const tokenBudget = callOpts.tokenBudget;
		let budgetExceeded = false;

		onInnerEvent?.(subId, "agent.identity", {
			color: subActor.color,
			address: subActor.address,
			modelId: resolvedModel.id,
		});

		observers.add((event) => {
			if (event.type === "token-usage") {
				const usage = event.usage;
				totalInputTokens += usage.input ?? 0;
				totalOutputTokens += usage.output ?? 0;
				if (tokenBudget && !budgetExceeded && totalInputTokens + totalOutputTokens >= tokenBudget) {
					budgetExceeded = true;
					controller.receive(
						"[system] Token budget reached. Wrap up now — summarize your findings and return your final answer. Do not start new tool calls.",
						"system",
					);
				}
				onInnerEvent?.(subId, "subagent-token-usage", {
					callId: subId,
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
				for (const [k, v] of Object.entries(event)) {
					if (k !== "type") payload[k] = v;
				}
				onInnerEvent(subId, event.type, payload);
			}
		});

		opts.actorRoutes?.register(subActor.color, async (message, timeout) => {
			await agent.ready();
			await controller.send(message, "human", timeout);
		});

		agent.validate();

		const session = new AgentSession({
			state: { id: subId, modelId: resolvedModel.id, contextWindow: resolvedModel.contextWindow },
			send: async (text, _sender, timeoutMs) => {
				await agent.ready();
				await controller.send(text, "human", timeoutMs);
				return reply;
			},
			receive: (text) => controller.receive(text, "human"),
			dispose: () => {
				opts.actorRoutes?.unregister(subActor.color);
				agent.dispose();
			},
			observers,
		}) as AgentSession & {
			identity: { color: string; address: string };
			tokenUsage: { input: number; output: number };
		};

		Object.defineProperty(session, "identity", {
			get: () => ({ color: subActor.color, address: subActor.address }),
		});
		Object.defineProperty(session, "tokenUsage", {
			get: () => ({ input: totalInputTokens, output: totalOutputTokens }),
		});

		return session;
	};
}
