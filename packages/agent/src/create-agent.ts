import type { Api, Model, ThinkingLevel } from "@dpopsuev/alef-ai/types";
import type { Agent } from "@dpopsuev/alef-engine/agent";
import { buildAdapterDirectives, createToolShellAdapter } from "@dpopsuev/alef-engine/catalog";
import { AgentController } from "@dpopsuev/alef-engine/controller";
import type { Adapter, ToolDefinition } from "@dpopsuev/alef-kernel/adapter";
import { createContextAssemblyPipeline } from "@dpopsuev/alef-kernel/pipeline";
import { buildAgent } from "./agent-kernel.js";
import { parseArgs } from "./args.js";
import { buildLlmAdapter } from "./build-llm-adapter.js";
import type { AlefConfig } from "./config.js";
import { createDefaultDirectives, loadWorkspace, registerAdapters } from "./prompt.js";

export interface CreateAgentOptions {
	cwd: string;
	model: Model<Api>;
	adapters: Adapter[];
	cfg?: AlefConfig;
	thinking?: ThinkingLevel;
	getSignal?: () => AbortSignal | undefined;
	schemaResolver?: (name: string) => ToolDefinition | undefined;
}

export interface AgentInstance {
	agent: Agent;
	controller: AgentController;
	systemPrompt: string;
}

export async function createAgent(opts: CreateAgentOptions): Promise<AgentInstance> {
	const args = { ...parseArgs([]), cwd: opts.cwd, noTui: true };
	const cfg = opts.cfg ?? {};
	const thinkingState = {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- args/cfg provide validated ThinkingLevel strings
		level: (opts.thinking ?? cfg.thinking ?? (opts.model.reasoning ? "medium" : undefined)) as
			| ThinkingLevel
			| undefined,
	};

	const directives = createDefaultDirectives({ tools: opts.adapters.flatMap((o) => o.tools), cwd: opts.cwd });
	await loadWorkspace(directives, opts.cwd);
	registerAdapters(directives, opts.adapters);

	const budgetChars = Math.floor(opts.model.contextWindow * 0.1 * 4);
	const systemPrompt = directives.build(budgetChars);

	const toolShell = createToolShellAdapter({
		tools: opts.adapters.flatMap((o) => o.tools),
		getTools: () => agent.tools,
		adapterDirectives: buildAdapterDirectives(opts.adapters),
	});

	const pipeline = createContextAssemblyPipeline();

	const llm = buildLlmAdapter({
		model: opts.model,
		cfg,
		args,
		thinkingState,
		getModel: () => opts.model,
		getSignal: opts.getSignal ?? (() => undefined),
		schemaResolver: opts.schemaResolver ?? ((name) => pipeline.getSchemaResolver()?.(name)),
		systemPrompt,
	});

	const agent = buildAgent({ llm, loopThreshold: 10 });

	for (const adapter of opts.adapters) agent.load(adapter);
	agent.load(toolShell);
	agent.load(pipeline);

	agent.validate();
	await agent.ready();

	const controller = new AgentController(agent);

	return { agent, controller, systemPrompt };
}
