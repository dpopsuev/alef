import type { Adapter, ToolDefinition } from "@dpopsuev/alef-kernel/adapter";
import type { ExecutionStrategy } from "@dpopsuev/alef-kernel/execution";
import type { ManagedService, RestartPolicy, ServiceCreateOpts, ServiceDescriptor } from "@dpopsuev/alef-supervisor/lifecycle";

/** Adapter instance plus service creation context used by Foundry helpers. */
export interface AdapterServiceContext<TAdapter extends Adapter = Adapter> {
	adapter: TAdapter;
	opts: ServiceCreateOpts;
}

/** Declarative shape for wrapping one adapter as a managed in-process service. */
export interface AdapterServiceDefinition<TAdapter extends Adapter = Adapter> {
	name: string;
	restart: RestartPolicy;
	shareable: boolean;
	dependsOn?: readonly string[];
	createAdapter(opts: ServiceCreateOpts): TAdapter | Promise<TAdapter>;
	start?(ctx: AdapterServiceContext<TAdapter>): Promise<void> | void;
	stop?(ctx: AdapterServiceContext<TAdapter>): Promise<void> | void;
	health?(ctx: AdapterServiceContext<TAdapter>): Promise<boolean> | boolean;
	getTools?(ctx: AdapterServiceContext<TAdapter>): readonly ToolDefinition[];
	getStrategy?(ctx: AdapterServiceContext<TAdapter>): ExecutionStrategy | undefined;
}

/** Close an adapter when the descriptor does not provide custom stop logic. */
async function stopAdapter(adapter: Adapter): Promise<void> {
	await adapter.close?.();
}

/** Build a `ServiceDescriptor` for the common one-adapter managed-service shape. */
export function defineAdapterService<TAdapter extends Adapter>(
	definition: AdapterServiceDefinition<TAdapter>,
): ServiceDescriptor {
	return {
		name: definition.name,
		restart: definition.restart,
		shareable: definition.shareable,
		dependsOn: definition.dependsOn,
		async create(opts: ServiceCreateOpts): Promise<ManagedService> {
			const adapter = await definition.createAdapter(opts);
			const context = { adapter, opts };

			return {
				name: definition.name,
				restart: definition.restart,
				adapters: [adapter],
				tools: [...(definition.getTools?.(context) ?? adapter.tools)],
				strategy: definition.getStrategy?.(context),
				async start() {
					await definition.start?.(context);
				},
				async stop() {
					if (definition.stop) {
						await definition.stop(context);
						return;
					}
					await stopAdapter(adapter);
				},
				async health() {
					if (definition.health) {
						return await definition.health(context);
					}
					return true;
				},
			};
		},
	};
}
