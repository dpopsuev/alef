import type { Adapter, AdapterLogger, ToolDefinition } from "@dpopsuev/alef-kernel/adapter";
import type { Bus } from "@dpopsuev/alef-kernel/bus";
import type { DiscussionRef } from "@dpopsuev/alef-kernel/execution";
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
	getOrStart(descriptor: ServiceDescriptor, opts: ServiceCreateOpts): Promise<ManagedService>;
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
	actorAddress?: string;
	discussion?: DiscussionRef;
	/** Active session id for stores that scope rows per session (e.g. discourse). */
	sessionId?: string;
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
