import type { Api, Model, ThinkingLevel } from "@dpopsuev/alef-ai/types";
import type { Agent } from "@dpopsuev/alef-engine/agent";
import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import type { ManagedService, ServiceCreateOpts, ServiceDescriptor } from "@dpopsuev/alef-supervisor/lifecycle";
import { buildAgent } from "./agent-kernel.js";
import type { Args } from "./args.js";
import { buildLlmAdapter } from "./build-llm-adapter.js";
import type { AlefConfig } from "./config.js";
import type { SessionStore } from "./session-store.js";

export interface AgentServiceOptions {
	args: Args;
	cfg: AlefConfig;
	model: Model<Api>;
	getModel: () => Model<Api>;
	getSignal: () => AbortSignal | undefined;
	thinkingState: { level: ThinkingLevel | undefined };
	systemPrompt?: string;
	sessionStore?: SessionStore;
	modelId?: string;
	extraAdapters?: Adapter[];
}

export interface AgentService extends ManagedService {
	readonly agent: Agent;
}

export function createAgentServiceDescriptor(opts: AgentServiceOptions, toolDeps: string[] = []): ServiceDescriptor {
	return {
		name: "agent",
		restart: "permanent",
		shareable: false,
		dependsOn: ["storage", ...toolDeps],

		create(createOpts: ServiceCreateOpts): Promise<AgentService> {
			const toolAdapters = createOpts.supervisor?.adapters() ?? [];

			const llm = buildLlmAdapter({
				model: opts.model,
				cfg: opts.cfg,
				args: opts.args,
				thinkingState: opts.thinkingState,
				getModel: opts.getModel,
				getSignal: opts.getSignal,
				systemPrompt: opts.systemPrompt,
			});

			const agent = buildAgent({
				llm,
				session: opts.sessionStore,
				modelId: opts.modelId,
			});

			for (const adapter of toolAdapters) {
				agent.load(adapter);
			}

			for (const adapter of opts.extraAdapters ?? []) {
				agent.load(adapter);
			}

			return Promise.resolve({
				name: "agent",
				restart: "permanent" as const,
				adapters: [llm],
				tools: [],
				agent,
				start: () => Promise.resolve(),
				stop() {
					agent.dispose();
					return Promise.resolve();
				},
				health: () => Promise.resolve(!agent.signal.aborted),
			});
		},
	};
}
