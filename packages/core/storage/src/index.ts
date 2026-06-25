export { SqliteAuthStore } from "./auth.js";
export { type DaemonEntry, SqliteDaemonStore } from "./daemon.js";
export {
	type Client,
	closeDatabase,
	configureStorage,
	getDatabase,
	makeTestDatabase,
	openDatabase,
	type StorageConfig,
	syncDatabase,
} from "./database.js";
export { type Post, SqliteDiscourseStore, type ThreadInfo, type TopicSummary } from "./discourse.js";
export { type Embedder, getEmbedder, setEmbedder } from "./embedder.js";
export type { AuthStore, DaemonStore, DiscourseStore, SessionStoreFactory, StorageFactory, SummaryStore } from "./interfaces.js";
export { SqliteStorageFactory } from "./sqlite-storage-factory.js";
export { LocalEmbedder } from "./local-embedder.js";
export { type MigrationResult, migrateJsonlToSqlite, needsMigration } from "./migrate.js";
export { type RecallResult, RecallStore, type SessionRecallResult } from "./recall.js";
export { applySchema, CURRENT_SCHEMA_VERSION, EMBEDDING_DIMENSION } from "./schema.js";
export { SqliteSessionStore } from "./session-store.js";
export { type SessionSummary, SqliteSummaryStore } from "./summary.js";
