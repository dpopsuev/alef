import {
	type BuildServiceOpts,
	createBuildServiceDescriptor,
	createFoundryRuntime,
	createSchedulerDescriptor,
	type FoundryRuntime,
} from "@dpopsuev/alef-foundry";
import type { StorageFactory } from "@dpopsuev/alef-storage";
import { openStorage, type StorageHandle, type StorageServiceConfig } from "@dpopsuev/alef-storage/service";
import { createAgentServiceDescriptor } from "./agent-service.js";
import type { Args } from "./args.js";
import type { AssembledSession } from "./assemble-session.js";
import type { AlefConfig } from "./config.js";

/** Options for the CLI-local Foundry bootstrap. */
export interface CliFoundryRuntimeOptions {
	cwd: string;
	storage?: StorageServiceConfig;
}

/** Inputs needed to register the agent daemon service against an already-assembled session. */
export interface RegisterAgentServiceOptions {
	args: Args;
	cfg: AlefConfig;
	storage: StorageFactory;
	session: AssembledSession;
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
	/** Register the agent daemon service -- Foundry's one independent restart boundary the CLI owns. */
	registerAgentService(opts: RegisterAgentServiceOptions): void;
}

/** Create the CLI-local Foundry runtime. Storage is opened directly, not registered as a service. */
export function createCliFoundryRuntime(options: CliFoundryRuntimeOptions): CliFoundryRuntime {
	const foundry = createFoundryRuntime({ cwd: options.cwd });
	foundry.register(createSchedulerDescriptor());

	let storageHandle: Promise<StorageHandle> | undefined;
	const ensureStorage = (): Promise<StorageHandle> => {
		storageHandle ??= openStorage(options.storage);
		return storageHandle;
	};

	return {
		foundry,
		resolveService: foundry.resolveService,
		get(name) {
			return foundry.get(name);
		},
		start() {
			return foundry.start({ cwd: options.cwd });
		},
		async stop() {
			await foundry.stop();
			(await storageHandle)?.close();
		},
		swap(name, opts) {
			return foundry.swap(name, opts);
		},
		async getStorage() {
			return (await ensureStorage()).factory;
		},
		registerBuildService(opts: BuildServiceOpts) {
			foundry.register(createBuildServiceDescriptor(opts));
		},
		registerAgentService(opts: RegisterAgentServiceOptions) {
			foundry.register(
				createAgentServiceDescriptor({
					args: opts.args,
					cfg: opts.cfg,
					storage: opts.storage,
					session: opts.session,
				}),
			);
		},
	};
}
