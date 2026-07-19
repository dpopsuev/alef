import type { Api, Model } from "@dpopsuev/alef-ai/types";
import {
	type BuildServiceOpts,
	createBuildServiceDescriptor,
	createFoundryRuntime,
	createSchedulerDescriptor,
	type FoundryRuntime,
} from "@dpopsuev/alef-foundry";
import type { SessionStore } from "@dpopsuev/alef-session/storage";
import type { StorageFactory } from "@dpopsuev/alef-storage";
import {
	createStorageDescriptor,
	type StorageService,
	type StorageServiceConfig,
} from "@dpopsuev/alef-storage/service";
import type { Logger } from "pino";
import type { AdapterLoadResult } from "./adapters.js";
import { createAgentServiceDescriptor } from "./agent-service.js";
import type { Args } from "./args.js";
import type { AlefConfig } from "./config.js";
import type { IdentityContext } from "./session.js";
import { createSessionServiceDescriptor } from "./session-service.js";
import { createTuiServiceDescriptor } from "./tui-service.js";

/** Options for the CLI-local Foundry bootstrap. */
export interface CliFoundryRuntimeOptions {
	cwd: string;
	storage?: StorageServiceConfig;
}

/** Inputs needed to register session/agent/TUI services on the CLI runtime. */
export interface CliApplicationServicesOptions {
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

/** CLI-specific Foundry facade above raw register/start/stop orchestration. */
export interface CliFoundryRuntime {
	readonly foundry: FoundryRuntime;
	resolveService: FoundryRuntime["resolveService"];
	get(name: string): ReturnType<FoundryRuntime["get"]>;
	start(): Promise<void>;
	stop(): Promise<void>;
	swap: FoundryRuntime["swap"];
	getStorage(): Promise<StorageFactory>;
	registerBuildService(opts: BuildServiceOpts): void;
	registerApplicationServices(opts: CliApplicationServicesOptions): void;
}

/** Create the CLI-local Foundry runtime with base storage and scheduler services. */
export function createCliFoundryRuntime(options: CliFoundryRuntimeOptions): CliFoundryRuntime {
	const foundry = createFoundryRuntime({ cwd: options.cwd });
	foundry.register(createStorageDescriptor(options.storage));
	foundry.register(createSchedulerDescriptor());

	return {
		foundry,
		resolveService: foundry.resolveService,
		get(name) {
			return foundry.get(name);
		},
		start() {
			return foundry.start({ cwd: options.cwd });
		},
		stop() {
			return foundry.stop();
		},
		swap(name, opts) {
			return foundry.swap(name, opts);
		},
		async getStorage() {
			await foundry.start({ cwd: options.cwd });
			const svc = foundry.get("storage");
			if (!svc) throw new Error("Storage service failed to start");
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- StorageService extends ManagedService with factory field
			return (svc as StorageService).factory;
		},
		registerBuildService(opts: BuildServiceOpts) {
			foundry.register(createBuildServiceDescriptor(opts));
		},
		registerApplicationServices(opts: CliApplicationServicesOptions) {
			foundry.register(
				createSessionServiceDescriptor({
					args: opts.args,
					cfg: opts.cfg,
					log: opts.log,
					store: opts.store,
					loaded: opts.loaded,
					reloadAdapters: opts.reloadAdapters,
					model: opts.model,
					storage: opts.storage,
					identity: opts.identity,
				}),
			);
			foundry.register(createAgentServiceDescriptor({ args: opts.args, cfg: opts.cfg, storage: opts.storage }));
			foundry.register(createTuiServiceDescriptor({ args: opts.args, store: opts.store }));
		},
	};
}
