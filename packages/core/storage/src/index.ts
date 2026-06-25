export { SqliteAuthStore } from "./auth.js";
export { KeyringAuthStore } from "./keyring-auth-store.js";
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
export { type Post, SqliteDiscourseStore, type ThreadInfo, type TopicSummary } from "./discourse.js";
export type { AuthStore, DaemonRegistry, DiscourseStore, SessionPreviewProvider, SessionStoreFactory, StorageFactory, SummaryStore } from "./interfaces.js";
export { InMemorySessionStore } from "./in-memory-session-store.js";
export { SqliteStorageFactory } from "./sqlite-storage-factory.js";
export { runPluginMigrations } from "./plugin-migrations.js";
export { applySchema, CURRENT_SCHEMA_VERSION, EMBEDDING_DIMENSION } from "./schema.js";
export { type EmbeddingCallback, setEmbeddingCallback, SqliteSessionStore } from "./session-store.js";
export { type SessionSummary, SqliteSummaryStore } from "./summary.js";
