export { SqliteAuthStore } from "./auth.js";
export { KeyringAuthStore } from "./keyring.js";
export { type DaemonEntry, SqliteDaemonRegistry } from "./daemon.js";
export {
	type Client,
	closeDatabase,
	configureStorage,
	getDatabase,
	makeTestDatabase,
	openDatabase,
	setDatabase,
	type StorageConfig,
	syncDatabase,
} from "./database.js";
export type { AuthStore, DaemonRegistry, SessionPreviewProvider, SessionStoreFactory, StorageFactory, SummaryStore } from "./interfaces.js";
export { InMemorySessionStore } from "./memory-session.js";
export { SqliteStorageFactory } from "./factory.js";
export { runPluginMigrations } from "./plugin-migrations.js";
export { applySchema, CURRENT_SCHEMA_VERSION, EMBEDDING_DIMENSION } from "./schema.js";
export { type EmbeddingCallback, setEmbeddingCallback, SqliteSessionStore } from "./sqlite-session.js";
export { type SessionSummary, SqliteSummaryStore } from "./summary.js";
