import type { ManagedService, ServiceCreateOpts, ServiceDescriptor } from "@dpopsuev/alef-supervisor/lifecycle";
import type { StorageFactory } from "./interfaces.js";

export interface StorageService extends ManagedService {
	readonly factory: StorageFactory;
}

export const service: ServiceDescriptor = {
	name: "storage",
	restart: "permanent",
	shareable: true,

	async create(_opts: ServiceCreateOpts): Promise<StorageService> {
		const { getDatabase } = await import("./sqlite/database.js");
		const { SqliteStorageFactory } = await import("./factory.js");
		const db = await getDatabase();
		const factory = new SqliteStorageFactory(db);

		return {
			name: "storage",
			restart: "permanent" as const,
			adapters: [],
			tools: [],
			factory,
			start: () => Promise.resolve(),
			stop() {
				factory.close();
				return Promise.resolve();
			},
			health: () => Promise.resolve(true),
		};
	},
};
