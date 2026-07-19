import type { Api, Model } from "@dpopsuev/alef-ai/types";
import type { RouterAdapter } from "@dpopsuev/alef-engine/http";
import { defineManagedService } from "@dpopsuev/alef-foundry";
import { traceEvent } from "@dpopsuev/alef-kernel/log";
import type { Session } from "@dpopsuev/alef-session/contracts";
import type { SessionStore } from "@dpopsuev/alef-session/storage";
import type { StorageFactory } from "@dpopsuev/alef-storage";
import type { ManagedService, ServiceDescriptor } from "@dpopsuev/alef-supervisor/lifecycle";
import type { Logger } from "pino";
import type { AdapterLoadResult } from "./adapters.js";
import type { Args } from "./args.js";
import type { AlefConfig } from "./config.js";
import { buildIdentityContext, createLocalSession, type IdentityContext } from "./session.js";

/** Dependencies injected into the session supervisor service. */
export interface SessionServiceOptions {
	args: Args;
	cfg: AlefConfig;
	log: Logger;
	store: SessionStore;
	loaded: AdapterLoadResult;
	model: Model<Api>;
	storage: StorageFactory;
	identity?: IdentityContext;
	reloadAdapters?: () => Promise<AdapterLoadResult>;
}

/** Managed service exposing the assembled session, model display, and HTTP surface setup. */
export interface SessionService extends ManagedService {
	readonly session: Session;
	readonly resolvedModelDisplay: string;
	readonly humanAddress: string;
	readonly agentAddress: string;
	readonly blueprintName: string;
	readonly blueprintPath: string | undefined;
	readonly setupSurface: () => Promise<{ port: number; router: RouterAdapter } | undefined>;
}

/** Build a ServiceDescriptor that assembles the local session with identity, adapters, and HTTP surface. */
export function createSessionServiceDescriptor(opts: SessionServiceOptions): ServiceDescriptor {
	let createCount = 0;
	return defineManagedService({
		name: "session",
		restart: "permanent",
		shareable: true,
		dependsOn: ["storage"],
		async create() {
			createCount++;
			const isReboot = createCount > 1;
			const t0 = Date.now();

			if (isReboot) {
				traceEvent("session:create:start", { attempt: createCount, reboot: true });
			}

			let loaded: AdapterLoadResult;
			if (isReboot && opts.reloadAdapters) {
				traceEvent("session:adapters:reload:start", {});
				const adapterT0 = Date.now();
				loaded = await opts.reloadAdapters();
				traceEvent("session:adapters:reload:done", {
					elapsedMs: Date.now() - adapterT0,
					adapterCount: loaded.adapters.length,
				});
			} else {
				loaded = opts.loaded;
			}

			const identity = opts.identity ?? buildIdentityContext(opts.store);

			if (isReboot) {
				traceEvent("session:assemble:start", {});
			}
			const assembleT0 = Date.now();

			const {
				session: handle,
				resolvedModelDisplay,
				humanAddress,
				agentAddress,
				blueprintName,
				setupSurface,
			} = await createLocalSession(
				opts.args,
				opts.cfg,
				opts.log,
				opts.store,
				loaded,
				opts.model,
				opts.storage,
				identity,
			);

			if (isReboot) {
				traceEvent("session:assemble:done", { elapsedMs: Date.now() - assembleT0 });
				traceEvent("session:create:done", { attempt: createCount, totalMs: Date.now() - t0 });
			}

			let stopped = false;
			return {
				session: handle,
				resolvedModelDisplay,
				humanAddress,
				agentAddress,
				blueprintName,
				blueprintPath: loaded.blueprintPath,
				setupSurface,
				stop() {
					stopped = true;
					void handle.dispose();
					return Promise.resolve();
				},
				health: () => Promise.resolve(!stopped),
			};
		},
	});
}
