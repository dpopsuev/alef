import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import type { StorageFactory } from "@dpopsuev/alef-storage";
import type { ManagedService, ServiceCreateOpts, ServiceDescriptor } from "@dpopsuev/alef-supervisor/lifecycle";
import type { Args } from "./args.js";
import type { SessionService } from "./session-service.js";

export interface AgentServiceOptions {
	args: Args;
	storage: StorageFactory;
}

export function createAgentServiceDescriptor(opts: AgentServiceOptions): ServiceDescriptor {
	return {
		name: "agent",
		restart: "permanent",
		shareable: false,
		dependsOn: ["session"],

		async create(createOpts: ServiceCreateOpts): Promise<ManagedService> {
			const raw = createOpts.supervisor?.get("session");
			if (!raw || !("session" in raw)) throw new Error("Session service not found — agent depends on session");
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowed by 'session' in check
			const sessionSvc = raw as SessionService;

			const listenPort = await sessionSvc.setupSurface();
			if (opts.args.daemon && listenPort !== undefined) {
				const daemonRegistry = opts.storage.daemonRegistry();
				await daemonRegistry.register({
					port: listenPort,
					pid: process.pid,
					sessionId: sessionSvc.session.state.id,
					cwd: opts.args.cwd,
					startedAt: Date.now(),
				});
			}

			let stopped = false;
			return {
				name: "agent",
				restart: "permanent" as const,
				adapters: [] as Adapter[],
				tools: [],
				start: () => Promise.resolve(),
				stop() {
					stopped = true;
					return Promise.resolve();
				},
				health: () => Promise.resolve(!stopped),
			};
		},
	};
}
