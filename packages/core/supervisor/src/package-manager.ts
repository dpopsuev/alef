// eslint-disable-next-line @typescript-eslint/no-unused-vars
import type { ManagedService, ServiceCreateOpts, ServiceDescriptor, ServiceRegistry } from "./lifecycle.js";

/**
 *
 */
export interface DiscoveredService {
	readonly name: string;
	readonly descriptor: ServiceDescriptor;
}

/**
 *
 */
export interface PackageManagerOps {
	discover(cwd: string): Promise<readonly DiscoveredService[]>;
	resolve?(name: string): Promise<ServiceDescriptor | undefined>;
	install?(pkg: string): Promise<DiscoveredService | undefined>;
	upgrade?(name: string): Promise<DiscoveredService | undefined>;
	remove?(name: string): Promise<boolean>;
	sbom?(): Record<string, string>;
}

/**
 *
 */
export interface PackageManager {
	discover(): Promise<readonly DiscoveredService[]>;
	resolve(name: string): Promise<ServiceDescriptor | undefined>;
	install(pkg: string): Promise<DiscoveredService | undefined>;
	upgrade(name: string): Promise<void>;
	remove(name: string): Promise<void>;
}

/**
 *
 */
export function createPackageManagerDescriptor(ops: PackageManagerOps): ServiceDescriptor {
	return {
		name: "pm",
		restart: "permanent",
		shareable: true,

		create(opts: ServiceCreateOpts): Promise<ManagedService & PackageManager> {
			const supervisor = opts.supervisor;
			const discovered = new Map<string, ServiceDescriptor>();

			const pm: PackageManager = {
				async discover() {
					const services = await ops.discover(opts.cwd);
					for (const svc of services) {
						discovered.set(svc.name, svc.descriptor);
						supervisor?.register(svc.descriptor);
					}
					return services;
				},

				async resolve(name) {
					const cached = discovered.get(name);
					if (cached) return cached;
					return ops.resolve?.(name);
				},

				async install(pkg) {
					const svc = await ops.install?.(pkg);
					if (svc) {
						discovered.set(svc.name, svc.descriptor);
						supervisor?.register(svc.descriptor);
					}
					return svc;
				},

				async upgrade(name) {
					const svc = await ops.upgrade?.(name);
					if (svc) {
						discovered.set(svc.name, svc.descriptor);
					}
				},

				async remove(name) {
					await ops.remove?.(name);
					discovered.delete(name);
				},
			};

			return Promise.resolve({
				name: "pm",
				restart: "permanent" as const,
				adapters: [],
				tools: [],
				...pm,
				async start() {
					await pm.discover();
				},
				stop: () => Promise.resolve(),
				health: () => Promise.resolve(true),
			});
		},
	};
}
