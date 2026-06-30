const DEFAULT_LOOP_THRESHOLD = 10;
const DIRECTIVE_BUDGET_FRACTION = 0.1;
const CHARS_PER_TOKEN = 4;
import type { Api, Model, ThinkingLevel } from "@dpopsuev/alef-ai/types";
import type { Agent } from "@dpopsuev/alef-engine/agent";
import { buildAdapterDirectives, createToolShellAdapter } from "@dpopsuev/alef-engine/catalog";
import { AgentController } from "@dpopsuev/alef-engine/controller";
import type { Adapter, ToolDefinition } from "@dpopsuev/alef-kernel/adapter";
import { createContextAssembler } from "@dpopsuev/alef-kernel/context-assembly";
import { buildAgent } from "./agent-kernel.js";
import { buildLlm, type LlmBuildOptions } from "./build-llm.js";
import type { Directives } from "./directives.js";
import { createDefaultDirectives, registerAdapters } from "./prompt.js";

export interface CreateAgentOptions {
	cwd: string;
	model: Model<Api>;
	adapters: Adapter[];
	thinking?: ThinkingLevel;
	getSignal?: () => AbortSignal | undefined;
	getApiKey?: (provider: string) => string | undefined;
	schemaResolver?: (name: string) => ToolDefinition | undefined;
	directives?: Directives;
	llm?: LlmBuildOptions["llm"];
	trackConcurrentOps?: boolean;
}

export interface AgentInstance {
	agent: Agent;
	controller: AgentController;
	systemPrompt: string;
}

export async function createAgent(opts: CreateAgentOptions): Promise<AgentInstance> {
	const thinkingState = {
		level: (opts.thinking ?? (opts.model.reasoning ? "medium" : undefined)) as ThinkingLevel | undefined,
	};

	const directives = opts.directives ?? createDefaultDirectives({ tools: opts.adapters.flatMap((o) => o.tools), cwd: opts.cwd });
	if (!opts.directives) registerAdapters(directives, opts.adapters);

	const budgetChars = Math.floor(opts.model.contextWindow * DIRECTIVE_BUDGET_FRACTION * CHARS_PER_TOKEN);
	const systemPrompt = directives.build(budgetChars);

	const toolShell = createToolShellAdapter({
		tools: opts.adapters.flatMap((o) => o.tools),
		getTools: () => agent.tools,
		adapterDirectives: buildAdapterDirectives(opts.adapters),
	});

	const contextAssembly = createContextAssembler();

	const llm = buildLlm({
		model: opts.model,
		thinkingState,
		getModel: () => opts.model,
		getSignal: opts.getSignal ?? (() => undefined),
		getApiKey: opts.getApiKey,
		schemaResolver: opts.schemaResolver ?? ((name) => contextAssembly.getSchemaResolver()?.(name)),
		systemPrompt,
		llm: opts.llm,
		trackConcurrentOps: opts.trackConcurrentOps,
	});

	const agent = buildAgent({ llm, loopThreshold: DEFAULT_LOOP_THRESHOLD });

	for (const adapter of opts.adapters) agent.load(adapter);
	agent.load(toolShell);
	agent.load(contextAssembly);

	agent.validate();
	await agent.ready();

	const controller = new AgentController(agent);

	return { agent, controller, systemPrompt };
}
