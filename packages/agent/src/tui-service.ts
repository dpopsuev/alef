import type { SessionStore } from "@dpopsuev/alef-session/storage";
import type { ManagedService, ServiceCreateOpts, ServiceDescriptor } from "@dpopsuev/alef-supervisor/lifecycle";
import type { AgentService } from "./agent-service.js";
import type { Args } from "./args.js";
import { selectViewMode } from "./view-mode.js";

export interface TuiServiceOptions {
	args: Args;
	store?: SessionStore;
}

export function createTuiServiceDescriptor(opts: TuiServiceOptions): ServiceDescriptor {
	return {
		name: "tui",
		restart: "permanent",
		shareable: true,
		dependsOn: ["agent"],

		create(createOpts: ServiceCreateOpts): Promise<ManagedService> {
			const raw = createOpts.supervisor?.get("agent");
			if (!raw || !("sessionHandle" in raw)) throw new Error("Agent service not found — TUI depends on agent");
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowed by 'sessionHandle' in check above
			const agentSvc = raw as AgentService;

			const interactiveOpts = {
				cwd: opts.args.cwd,
				modelId: agentSvc.resolvedModelDisplay,
				sessionId: agentSvc.sessionHandle.state.id,
				contextWindow: agentSvc.sessionHandle.state.contextWindow,
				getModel: () => agentSvc.sessionHandle.getModel(),
				setModel: (id: string) => agentSvc.sessionHandle.setModel(id),
				getThinking: () => agentSvc.sessionHandle.getThinking(),
				setThinking: (level: string) => agentSvc.sessionHandle.setThinking(level),
				humanAddress: agentSvc.humanAddress,
				agentAddress: agentSvc.agentAddress,
			};

			const viewer = selectViewMode(opts.args, interactiveOpts, opts.store);
			let running = false;

			return Promise.resolve({
				name: "tui",
				restart: "permanent" as const,
				adapters: [],
				tools: [],
				start() {
					running = true;
					void viewer.run(agentSvc.sessionHandle).finally(() => {
						running = false;
					});
					return Promise.resolve();
				},
				stop() {
					running = false;
					return Promise.resolve();
				},
				health: () => Promise.resolve(running),
			});
		},
	};
}
