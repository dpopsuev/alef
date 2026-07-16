import type { CompiledAgentDefinition } from "@dpopsuev/alef-blueprint/types";
import type { Adapter, AdapterLogger, ToolDefinition } from "@dpopsuev/alef-kernel/adapter";
import type { Bus } from "@dpopsuev/alef-kernel/bus";
import type { DiscussionRef } from "@dpopsuev/alef-kernel/execution";
import type { AdapterFactoryOptions, MaterializerOptions, MaterializerResult } from "@dpopsuev/alef-blueprint/materializer";
import type { ManagedService, ServiceCreateOpts, ServiceDescriptor } from "@dpopsuev/alef-supervisor/lifecycle";
import type { Supervisor } from "@dpopsuev/alef-supervisor/supervisor";

/** Shared defaults for a Foundry runtime instance. */
export interface FoundryRuntimeOptions {
	cwd: string;
	logger?: AdapterLogger;
	bus?: Bus;
	loggerFor?: MaterializerOptions["loggerFor"];
	allowedTools?: MaterializerOptions["allowedTools"];
	resolveExternalPath?: MaterializerOptions["resolveExternalPath"];
	writableRoots?: MaterializerOptions["writableRoots"];
	sessionDir?: MaterializerOptions["sessionDir"];
	actorAddress?: string;
	discussion?: DiscussionRef;
}

/** Per-call overrides when starting registered services through Foundry. */
export interface FoundryStartOptions {
	cwd?: string;
	bus?: Bus;
	logger?: AdapterLogger;
	actorAddress?: string;
	discussion?: DiscussionRef;
}

/** Per-call overrides when materializing a blueprint through Foundry. */
export interface FoundryMaterializeOptions {
	cwd?: string;
	loggerFor?: MaterializerOptions["loggerFor"];
	allowedTools?: MaterializerOptions["allowedTools"];
	resolveExternalPath?: MaterializerOptions["resolveExternalPath"];
	writableRoots?: MaterializerOptions["writableRoots"];
	sessionDir?: MaterializerOptions["sessionDir"];
	actorAddress?: string;
	discussion?: DiscussionRef;
}

/** Minimal managed-service host surface exposed by Foundry. */
export interface FoundryServiceHost {
	get(name: string): ManagedService | undefined;
	names(): string[];
	ensure(descriptor: ServiceDescriptor, opts?: FoundryStartOptions): Promise<ManagedService>;
	stopService(name: string): Promise<void>;
}

/** Supervisor-backed runtime facade for service resolution and blueprint loading. */
export interface FoundryRuntime extends FoundryServiceHost {
	readonly supervisor: Supervisor;
	register(descriptor: ServiceDescriptor): void;
	adapters(): Adapter[];
	tools(): ToolDefinition[];
	start(opts?: FoundryStartOptions): Promise<void>;
	swap(name: string, opts?: FoundryStartOptions): Promise<void>;
	stop(): Promise<void>;
	resolveService(service: unknown, opts: AdapterFactoryOptions): Promise<readonly Adapter[] | undefined>;
	materializeBlueprint(definition: CompiledAgentDefinition, opts?: FoundryMaterializeOptions): Promise<MaterializerResult>;
}

/** Function signature for resolving a service-backed adapter entry. */
export type FoundryServiceResolver = FoundryRuntime["resolveService"];
/** Function signature for blueprint materialization through Foundry. */
export type FoundryMaterialize = FoundryRuntime["materializeBlueprint"];
/** Function signature for starting registered services through Foundry. */
export type FoundryStart = (opts?: FoundryStartOptions) => Promise<void>;
/** Shared service-create payload shape reused by Foundry helpers. */
export type FoundryServiceCreateOpts = ServiceCreateOpts;
