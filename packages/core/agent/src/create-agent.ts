const DEFAULT_LOOP_THRESHOLD = 10;
const DIRECTIVE_BUDGET_FRACTION = 0.1;
const CHARS_PER_TOKEN = 4;
import type { Api, Model, ThinkingLevel } from "@dpopsuev/alef-ai/types";
import type { Agent } from "@dpopsuev/alef-engine/agent";
import { buildAdapterDirectives, createToolShellAdapter } from "@dpopsuev/alef-engine/catalog";
import { AgentController } from "@dpopsuev/alef-engine/controller";
import type { Adapter, ToolDefinition } from "@dpopsuev/alef-kernel/adapter";
import { newCorrelationId } from "@dpopsuev/alef-kernel/bus";
import { createContextAssembler } from "@dpopsuev/alef-kernel/context-assembly";
import type { DesiredStateSpec } from "@dpopsuev/alef-kernel/reconciliation";
import { buildAgent } from "./agent-kernel.js";
import { buildLlm, type LlmBuildOptions } from "./build-llm.js";
import { Directives, xmlRenderer } from "./directives.js";
import { createDefaultDirectives, registerAdapters } from "./prompt.js";

/**
 *
 */
export interface CreateAgentOptions {
	cwd: string;
	model: Model<Api>;
	adapters: Adapter[];
	thinking?: ThinkingLevel;
	getSignal?: () => AbortSignal | undefined;
	getApiKey?: (provider: string) => string | undefined;
	schemaResolver?: (name: string) => ToolDefinition | undefined;
	/** Full directive set. Ignored when `systemPrompt` is set (lean mode). */
	directives?: Directives;
	/**
	 * Lean mode: session system prompt + adapter directives + environment.
	 * Skips the coding-agent persona blocks.
	 */
	systemPrompt?: string;
	/** When set, skip buildLlm and use this adapter as the reasoner. */
	llmAdapter?: Adapter;
	llm?: LlmBuildOptions["llm"];
	/** Collect tool conditions for ErrorTensor / ProgressTelemetry. Default true. */
	trackConcurrentOps?: boolean;
	/** Publish plan.dss after mount so Gap/Progress can be non-null. */
	desiredState?: DesiredStateSpec;
}

/**
 *
 */
export interface AgentInstance {
	agent: Agent;
	controller: AgentController;
	systemPrompt: string;
}

/** Lean directives: caller system prompt + adapter directives + environment. */
function createLeanDirectives(opts: {
	systemPrompt: string;
	adapters: readonly Adapter[];
	cwd: string;
}): Directives {
	const tools = opts.adapters.flatMap((adapter) => adapter.tools);
	const directives = new Directives();
	directives.renderer = xmlRenderer;
	directives.register({
		id: "session.system",
		priority: 0,
		content: opts.systemPrompt,
		enabled: true,
		tags: ["session"],
	});
	const defaults = createDefaultDirectives({ tools, cwd: opts.cwd });
	const environment = defaults.get("environment");
	if (environment) directives.register(environment);
	registerAdapters(directives, opts.adapters);
	return directives;
}

/**
 *
 */
export async function createAgent(opts: CreateAgentOptions): Promise<AgentInstance> {
	const thinkingState = {
		level: opts.thinking ?? (opts.model.reasoning ? "medium" : undefined),
	};

	const tools = opts.adapters.flatMap((adapter) => adapter.tools);
	let directives: Directives;
	if (opts.systemPrompt !== undefined) {
		directives = createLeanDirectives({
			systemPrompt: opts.systemPrompt,
			adapters: opts.adapters,
			cwd: opts.cwd,
		});
	} else if (opts.directives) {
		directives = opts.directives;
	} else {
		directives = createDefaultDirectives({ tools, cwd: opts.cwd });
		registerAdapters(directives, opts.adapters);
	}

	const budgetChars = Math.floor(opts.model.contextWindow * DIRECTIVE_BUDGET_FRACTION * CHARS_PER_TOKEN);
	const systemPrompt = directives.build(budgetChars);

	const contextAssembly = createContextAssembler();

	const llm =
		opts.llmAdapter ??
		buildLlm({
			model: opts.model,
			thinkingState,
			getModel: () => opts.model,
			getSignal: opts.getSignal ?? (() => undefined),
			getApiKey: opts.getApiKey,
			schemaResolver: opts.schemaResolver ?? ((name) => contextAssembly.getSchemaResolver()?.(name)),
			systemPrompt,
			llm: opts.llm,
			trackConcurrentOps: opts.trackConcurrentOps ?? true,
		});

	const agent = buildAgent({ llm, loopThreshold: DEFAULT_LOOP_THRESHOLD });

	if (process.env.ALEF_OTEL === "1" || process.env.TRACEPARENT?.trim()) {
		const { setupOTel, upgradeToSqliteExporter } = await import("./otel-setup.js");
		setupOTel();
		await upgradeToSqliteExporter();
	}

	const toolShell = createToolShellAdapter({
		tools,
		getTools: () => agent.tools,
		adapterDirectives: buildAdapterDirectives(opts.adapters),
	});

	for (const adapter of opts.adapters) agent.load(adapter);
	agent.load(toolShell);
	agent.load(contextAssembly);

	agent.validate();
	await agent.ready();

	if (opts.desiredState) {
		agent.asBus().notification.publish({
			type: "plan.dss",
			payload: {
				intent: opts.desiredState.intent,
				dimensions: opts.desiredState.dimensions,
			},
			correlationId: newCorrelationId(),
		});
	}

	const controller = new AgentController(agent);

	return { agent, controller, systemPrompt };
}
