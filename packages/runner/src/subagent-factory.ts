import type { SubagentFactory } from "@dpopsuev/alef-agent-blueprint";
import { createContextAssemblyPipeline } from "@dpopsuev/alef-kernel";
import type { Api, Model } from "@dpopsuev/alef-llm";
import { DialogOrgan } from "@dpopsuev/alef-organ-dialog";
import { createAgentLoop } from "@dpopsuev/alef-organ-llm";
import { buildOrganDirectives, createToolShellOrgan } from "@dpopsuev/alef-organ-toolshell";
import { Agent } from "@dpopsuev/alef-runtime";
import { resolveSubagentActor } from "./identity/actor.js";
import type { ActorRouteTable } from "./identity/routes.js";
import { buildModel } from "./model.js";

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
		const dialog = new DialogOrgan({
			sink: (text) => {
				if (text) reply = text;
			},
		});
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
		for (const organ of organs) agent.load(organ);
		const toolShell = createToolShellOrgan({
			tools: organs.flatMap((o) => o.tools),
			getTools: () => agent.tools,
			organDirectives: buildOrganDirectives([...organs]),
		});
		const pipeline = createContextAssemblyPipeline();
		agent.load(toolShell);
		agent.load(pipeline);
		agent.load(dialog).load(llm);
		// Emit identity immediately so the parent can display @colorName.
		onInnerEvent?.(subId, "agent.identity", { color: subActor.color, address: subActor.address });

		const tokenBudget = callOpts.tokenBudget;
		let budgetExceeded = false;

		agent.observe({
			onMotorEvent() {},
			onSenseEvent() {},
			onSignalEvent(event) {
				const payload = (event as { payload?: Record<string, unknown> }).payload ?? {};
				if (event.type === "llm.token-usage") {
					const usage = payload.usage as { input?: number; output?: number } | undefined;
					if (usage) {
						totalInputTokens += usage.input ?? 0;
						totalOutputTokens += usage.output ?? 0;
					}
					if (tokenBudget && !budgetExceeded && totalInputTokens + totalOutputTokens >= tokenBudget) {
						budgetExceeded = true;
						dialog.receive(
							"[system] Token budget reached. Wrap up now — summarize your findings and return your final answer. Do not start new tool calls.",
							"system",
						);
					}
				}
				if (chunkHandler) {
					if (event.type === "llm.chunk") chunkHandler(String(payload.text ?? ""));
					else if (opts.forwardToolChunks && event.type === "llm.tool-chunk")
						chunkHandler(String(payload.text ?? ""));
				}
				onInnerEvent?.(subId, event.type, payload);
			},
		});

		// Register subagent address so the TUI can route @color messages to it.
		opts.actorRoutes?.register(subActor.color, async (message, timeout) => {
			await agent.ready();
			await dialog.send(message, "human", timeout);
		});

		return {
			async send(text: string, sender: string, timeoutMs: number): Promise<string> {
				await agent.ready();
				await dialog.send(text, sender, timeoutMs);
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
