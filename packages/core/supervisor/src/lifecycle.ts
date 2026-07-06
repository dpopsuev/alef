import type { Adapter, AdapterLogger, ToolDefinition } from "@dpopsuev/alef-kernel/adapter";
import type { Bus } from "@dpopsuev/alef-kernel/bus";
import type { ExecutionStrategy } from "@dpopsuev/alef-kernel/execution";

/**
 *
 */
export type RestartPolicy = "permanent" | "transient" | "temporary";

/**
 *
 */
export interface ManagedLifecycle {
	readonly name: string;
	start(): Promise<void>;
	stop(): Promise<void>;
	health(): Promise<boolean>;
	readonly restart: RestartPolicy;
}

/**
 *
 */
export interface ServiceRegistry {
	register(descriptor: ServiceDescriptor): void;
	stop(name: string): Promise<void>;
	get(name: string): ManagedService | undefined;
	adapters(): Adapter[];
	tools(): ToolDefinition[];
	names(): string[];
}

/**
 *
 */
export interface ServiceCreateOpts {
	cwd: string;
	bus?: Bus;
	logger?: AdapterLogger;
	supervisor?: ServiceRegistry;
}

/**
 *
 */
export interface ServiceDescriptor {
	readonly name: string;
	readonly restart: RestartPolicy;
	readonly shareable: boolean;
	readonly dependsOn?: readonly string[];
	create(opts: ServiceCreateOpts): Promise<ManagedService>;
}

/**
 *
 */
export interface ManagedService extends ManagedLifecycle {
	readonly adapters: readonly Adapter[];
	readonly tools: readonly ToolDefinition[];
	readonly strategy?: ExecutionStrategy;
}
