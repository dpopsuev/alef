import type { SubagentFactory } from "@dpopsuev/alef-agent-blueprint";
import { createContextAssemblyPipeline } from "@dpopsuev/alef-kernel";
import type { Api, Model } from "@dpopsuev/alef-llm";
import { createAgentLoop } from "@dpopsuev/alef-reasoner";
import {
	Agent,
	AgentController,
	buildAdapterDirectives,
	createToolShellAdapter,
	type Transcript,
} from "@dpopsuev/alef-runtime";
import { resolveSubagentActor } from "./identity/actor.js";
import type { ActorRouteTable } from "./identity/routes.js";
import { buildModel } from "./model/index.js";

export interface SubagentSessionOptions {
	model: Model<Api>;
	baseSystemPrompt?: string;
	trackConcurrentOps?: boolean;
	forwardToolChunks?: boolean;
	/** Parent session ID — used for deterministic subagent color assignment. */
	parentSessionId?: string;
	/** Board ID — used for deterministic subagent color assignment. */
	boardId?: string;
	/** If provided, subagent addresses are registered/unregistered here. */
	actorRoutes?: ActorRouteTable;
	/** Forum store for persisting subagent conversations as threads. */
	transcript?: Transcript;
}

export function buildSubagentFactory(opts: SubagentSessionOptions): SubagentFactory {
	return (callOpts) => {
		const { organs, onChunk, onInnerEvent, systemPrompt: callSystemPrompt, modelOverride } = callOpts;
		// Assign a deterministic color for this subagent instance.
		const subId = `${opts.parentSessionId ?? "sub"}_${Math.random().toString(36).slice(2, 10)}`;
		const subActor = resolveSubagentActor(opts.parentSessionId ?? "sub", subId, opts.boardId ?? "");

		const agent = new Agent();
		let reply = "";
		let totalInputTokens = 0;
		let totalOutputTokens = 0;
		const dateContext = `Date: ${new Date().toISOString().split("T")[0]}`;
		const systemPrompt =
			[dateContext, opts.baseSystemPrompt, callSystemPrompt].filter(Boolean).join("\n\n") || undefined;
		const chunkHandler = onChunk;
		const resolvedModel = modelOverride ? buildModel(modelOverride) : opts.model;
		const llm = createAgentLoop({
			model: resolvedModel,
			systemPrompt,
			trackConcurrentOps: opts.trackConcurrentOps,
			phaseTimeoutMs: 100,
		});
		for (const adapter of organs) agent.load(adapter);
		const toolShell = createToolShellAdapter({
			tools: organs.flatMap((o) => o.tools),
			getTools: () => agent.tools,
			adapterDirectives: buildAdapterDirectives([...organs]),
		});
		const pipeline = createContextAssemblyPipeline();
		agent.load(toolShell);
		agent.load(pipeline);
		agent.load(llm);

		const controller = new AgentController(agent, {
			onReply: (text) => {
				if (text) reply = text;
			},
			...(opts.transcript && { transcript: { store: opts.transcript, topic: "subagents", thread: subId } }),
		});
		// Emit identity immediately so the parent can display @colorName.
		onInnerEvent?.(subId, "agent.identity", { color: subActor.color, address: subActor.address });

		const tokenBudget = callOpts.tokenBudget;
		let budgetExceeded = false;

		agent.observe({
			onCommand() {},
			onEvent() {},
			onNotification(event) {
				const payload = (event as { payload?: Record<string, unknown> }).payload ?? {};
				if (event.type === "llm.token-usage") {
					const usage = payload.usage as { input?: number; output?: number } | undefined;
					if (usage) {
						totalInputTokens += usage.input ?? 0;
						totalOutputTokens += usage.output ?? 0;
					}
					if (tokenBudget && !budgetExceeded && totalInputTokens + totalOutputTokens >= tokenBudget) {
						budgetExceeded = true;
						controller.receive(
							"[system] Token budget reached. Wrap up now — summarize your findings and return your final answer. Do not start new tool calls.",
							"system",
						);
					}
				}
				if (chunkHandler) {
					if (event.type === "llm.chunk") chunkHandler(typeof payload.text === "string" ? payload.text : "");
					else if (opts.forwardToolChunks && event.type === "llm.tool-chunk")
						chunkHandler(typeof payload.text === "string" ? payload.text : "");
				}
				onInnerEvent?.(subId, event.type, payload);
			},
		});

		// Register subagent address so the TUI can route @color messages to it.
		opts.actorRoutes?.register(subActor.color, async (message, timeout) => {
			await agent.ready();
			await controller.send(message, "human", timeout);
		});

		return {
			async send(text: string, sender: string, timeoutMs: number): Promise<string> {
				await agent.ready();
				await controller.send(text, sender, timeoutMs);
				return reply;
			},
			get identity() {
				return { color: subActor.color, address: subActor.address };
			},
			get tokenUsage() {
				return { input: totalInputTokens, output: totalOutputTokens };
			},
			dispose() {
				opts.actorRoutes?.unregister(subActor.color);
				agent.dispose();
			},
		};
	};
}
