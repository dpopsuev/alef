import type { Api, Model } from "@dpopsuev/alef-ai/types";
import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import type { StorageFactory } from "@dpopsuev/alef-storage";
import type { ManagedService, ServiceCreateOpts, ServiceDescriptor } from "@dpopsuev/alef-supervisor/lifecycle";
import type { Logger } from "pino";
import type { Args } from "./args.js";
import type { AdapterLoadResult } from "./cli/load-adapters.js";
import { createLocalSession, type IdentityContext } from "./cli/local-session.js";
import type { AlefConfig } from "./config.js";
import type { SessionHandle } from "./session-lifecycle/index.js";
import type { SessionStore } from "./session-store.js";

export interface AgentServiceOptions {
	args: Args;
	cfg: AlefConfig;
	log: Logger;
	store: SessionStore;
	loaded: AdapterLoadResult;
	model: Model<Api>;
	storage: StorageFactory;
	identity: IdentityContext;
}

export interface AgentService extends ManagedService {
	readonly sessionHandle: SessionHandle;
	readonly resolvedModelDisplay: string;
	readonly humanAddress: string;
	readonly agentAddress: string;
}

export function createAgentServiceDescriptor(opts: AgentServiceOptions): ServiceDescriptor {
	return {
		name: "agent",
		restart: "permanent",
		shareable: false,
		dependsOn: ["storage"],

		async create(_createOpts: ServiceCreateOpts): Promise<AgentService> {
			const {
				session: sessionHandle,
				resolvedModelDisplay,
				humanAddress,
				agentAddress,
				actorRoutes: _actorRoutes,
				setupSurface,
			} = await createLocalSession(
				opts.args,
				opts.cfg,
				opts.log,
				opts.store,
				opts.loaded,
				opts.model,
				opts.storage,
				opts.identity,
			);

			const listenPort = await setupSurface();
			if (opts.args.daemon && listenPort !== undefined) {
				const daemonRegistry = opts.storage.daemonRegistry();
				await daemonRegistry.register({
					port: listenPort,
					pid: process.pid,
					sessionId: opts.store.id,
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
				sessionHandle,
				resolvedModelDisplay,
				humanAddress,
				agentAddress,
				start: () => Promise.resolve(),
				stop() {
					stopped = true;
					sessionHandle.dispose();
					return Promise.resolve();
				},
				health: () => Promise.resolve(!stopped),
			};
		},
	};
}
