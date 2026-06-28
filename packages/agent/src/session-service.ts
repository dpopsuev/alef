import type { Api, Model } from "@dpopsuev/alef-ai/types";
import type { RouterAdapter } from "@dpopsuev/alef-engine/http";
import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import type { Session } from "@dpopsuev/alef-session/contracts";
import type { SessionStore } from "@dpopsuev/alef-session/storage";
import type { StorageFactory } from "@dpopsuev/alef-storage";
import type { ManagedService, ServiceCreateOpts, ServiceDescriptor } from "@dpopsuev/alef-supervisor/lifecycle";
import type { Logger } from "pino";
import type { Args } from "./args.js";
import type { AdapterLoadResult } from "./cli/load-adapters.js";
import { buildIdentityContext, createLocalSession } from "./cli/local-session.js";
import type { AlefConfig } from "./config.js";

export interface SessionServiceOptions {
	args: Args;
	cfg: AlefConfig;
	log: Logger;
	store: SessionStore;
	loaded: AdapterLoadResult;
	model: Model<Api>;
	storage: StorageFactory;
}

export interface SessionService extends ManagedService {
	readonly session: Session;
	readonly resolvedModelDisplay: string;
	readonly humanAddress: string;
	readonly agentAddress: string;
	readonly setupSurface: () => Promise<{ port: number; router: RouterAdapter } | undefined>;
}

export function createSessionServiceDescriptor(opts: SessionServiceOptions): ServiceDescriptor {
	return {
		name: "session",
		restart: "permanent",
		shareable: true,
		dependsOn: ["storage"],

		async create(_createOpts: ServiceCreateOpts): Promise<SessionService> {
			const identity = buildIdentityContext(opts.store);

			const {
				session: handle,
				resolvedModelDisplay,
				humanAddress,
				agentAddress,
				setupSurface,
			} = await createLocalSession(
				opts.args,
				opts.cfg,
				opts.log,
				opts.store,
				opts.loaded,
				opts.model,
				opts.storage,
				identity,
			);

			let stopped = false;
			return {
				name: "session",
				restart: "permanent" as const,
				adapters: [] as Adapter[],
				tools: [],
				session: handle,
				resolvedModelDisplay,
				humanAddress,
				agentAddress,
				setupSurface,
				start: () => Promise.resolve(),
				stop() {
					stopped = true;
					handle.dispose();
					return Promise.resolve();
				},
				health: () => Promise.resolve(!stopped),
			};
		},
	};
}
