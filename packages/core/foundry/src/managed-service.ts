import type { Adapter, ToolDefinition } from "@dpopsuev/alef-kernel/adapter";
import type { ExecutionStrategy } from "@dpopsuev/alef-kernel/execution";
import type { ManagedService, RestartPolicy, ServiceCreateOpts, ServiceDescriptor } from "@dpopsuev/alef-supervisor/lifecycle";

/** Optional managed-service fields that Foundry can default when omitted. */
export interface ManagedServiceBody {
	adapters?: readonly Adapter[];
	tools?: readonly ToolDefinition[];
	strategy?: ExecutionStrategy;
	start?: () => Promise<void>;
	stop?: () => Promise<void>;
	health?: () => Promise<boolean>;
}

/** Declarative shape for wrapping a custom runtime object as a managed service. */
export interface ManagedServiceDefinition<TExtra extends object = object> {
	name: string;
	restart: RestartPolicy;
	shareable: boolean;
	dependsOn?: readonly string[];
	create(opts: ServiceCreateOpts): (TExtra & ManagedServiceBody) | Promise<TExtra & ManagedServiceBody>;
}

/** Build a `ServiceDescriptor` for a custom managed service with sensible defaults. */
export function defineManagedService<TExtra extends object = object>(
	definition: ManagedServiceDefinition<TExtra>,
): ServiceDescriptor {
	return {
		name: definition.name,
		restart: definition.restart,
		shareable: definition.shareable,
		dependsOn: definition.dependsOn,
		async create(opts: ServiceCreateOpts): Promise<ManagedService> {
			const serviceBody = await definition.create(opts);
			const {
				adapters = [],
				tools = [],
				strategy,
				start = () => Promise.resolve(),
				stop = () => Promise.resolve(),
				health = () => Promise.resolve(true),
				...extra
			} = serviceBody;

			return {
				name: definition.name,
				restart: definition.restart,
				adapters: [...adapters],
				tools: [...tools],
				strategy,
				...extra,
				start,
				stop,
				health,
			};
		},
	};
}
