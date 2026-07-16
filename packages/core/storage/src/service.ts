import { defineManagedService } from "@dpopsuev/alef-foundry";
import type { ManagedService, ServiceDescriptor } from "@dpopsuev/alef-supervisor/lifecycle";
import type { StorageFactory } from "./interfaces.js";

/**
 *
 */
export interface StorageService extends ManagedService {
	readonly factory: StorageFactory;
}

/**
 *
 */
export interface StorageServiceConfig {
	backend?: "local" | "turso";
	tursoUrl?: string;
	tursoToken?: string;
	syncInterval?: number;
}

/**
 *
 */
export function createStorageDescriptor(config?: StorageServiceConfig): ServiceDescriptor {
	return defineManagedService({
		name: "storage",
		restart: "permanent",
		shareable: true,
		async create() {
			if (config) {
				const { configureStorage } = await import("./sqlite/database.js");
				configureStorage(config);
			}
			const { getDatabase } = await import("./sqlite/database.js");
			const { SqliteStorageFactory } = await import("./factory.js");
			const db = await getDatabase();
			const factory = new SqliteStorageFactory(db);

			return {
				factory,
				stop() {
					factory.close();
					return Promise.resolve();
				},
				health: () => Promise.resolve(true),
			};
		},
	});
}
