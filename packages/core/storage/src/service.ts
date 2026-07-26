import type { StorageFactory } from "./interfaces.js";

/** Storage backend configuration. */
export interface StorageServiceConfig {
	backend?: "local" | "turso";
	tursoUrl?: string;
	tursoToken?: string;
	syncInterval?: number;
}

/** Opened storage: the factory plus its own close boundary. Not an independent restart target. */
export interface StorageHandle {
	readonly factory: StorageFactory;
	close(): void;
}

/** Open the SQLite-backed storage factory directly. Storage has no restart-in-place behavior of its own. */
export async function openStorage(config?: StorageServiceConfig): Promise<StorageHandle> {
	if (config) {
		const { configureStorage } = await import("./sqlite/database.js");
		configureStorage(config);
	}
	const { getDatabase } = await import("./sqlite/database.js");
	const { SqliteStorageFactory } = await import("./factory.js");
	const db = await getDatabase();
	const factory = new SqliteStorageFactory(db);
	return { factory, close: () => factory.close() };
}
