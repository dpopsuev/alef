import type { Client } from "@libsql/client";

export const CURRENT_SCHEMA_VERSION = 6;
export const EMBEDDING_DIMENSION = 384;

const DDL_STATEMENTS = [
	`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`,
	`CREATE TABLE IF NOT EXISTS sessions (
		id TEXT PRIMARY KEY, cwd_hash TEXT NOT NULL, cwd TEXT, name TEXT,
		created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, version TEXT)`,
	`CREATE INDEX IF NOT EXISTS idx_sessions_cwd ON sessions(cwd_hash)`,
	`CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at)`,
	`CREATE TABLE IF NOT EXISTS events (
		rowid INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
		bus TEXT NOT NULL, type TEXT NOT NULL, correlation_id TEXT NOT NULL,
		payload TEXT NOT NULL, timestamp INTEGER NOT NULL, elapsed INTEGER,
		hash TEXT, actor_address TEXT, actor_type TEXT, adapter TEXT,
		turn_number INTEGER, version TEXT, embedding F32_BLOB(${EMBEDDING_DIMENSION}))`,
	`CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id)`,
	`CREATE INDEX IF NOT EXISTS idx_events_correlation ON events(session_id, correlation_id)`,
	`CREATE INDEX IF NOT EXISTS idx_events_type ON events(session_id, type)`,
	`CREATE INDEX IF NOT EXISTS idx_events_bus ON events(session_id, bus)`,
	`CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(session_id, timestamp)`,
	`CREATE INDEX IF NOT EXISTS idx_events_adapter ON events(session_id, adapter)`,
	`CREATE TABLE IF NOT EXISTS auth (
		provider TEXT PRIMARY KEY, type TEXT NOT NULL DEFAULT 'api_key', key TEXT NOT NULL)`,
	`CREATE TABLE IF NOT EXISTS daemon (
		session_id TEXT PRIMARY KEY, port INTEGER NOT NULL, pid INTEGER NOT NULL,
		cwd TEXT, started_at INTEGER, host TEXT DEFAULT '127.0.0.1',
		last_heartbeat INTEGER, token TEXT)`,
	`CREATE TABLE IF NOT EXISTS session_summaries (
		session_id TEXT PRIMARY KEY REFERENCES sessions(id), model TEXT NOT NULL,
		started_at TEXT NOT NULL, duration_ms INTEGER NOT NULL, turns INTEGER NOT NULL,
		input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, tools TEXT NOT NULL,
		errors INTEGER NOT NULL, embedding F32_BLOB(${EMBEDDING_DIMENSION}))`,
];

const MIGRATIONS: Record<number, string[]> = {
	2: [
		`ALTER TABLE events ADD COLUMN embedding F32_BLOB(${EMBEDDING_DIMENSION})`,
		`ALTER TABLE session_summaries ADD COLUMN embedding F32_BLOB(${EMBEDDING_DIMENSION})`,
	],
	3: [
		`ALTER TABLE events RENAME COLUMN organ TO adapter`,
	],
	4: [
		`CREATE TABLE IF NOT EXISTS daemon_v2 (
			session_id TEXT PRIMARY KEY, port INTEGER NOT NULL, pid INTEGER NOT NULL,
			cwd TEXT, started_at INTEGER)`,
		`INSERT OR IGNORE INTO daemon_v2 (session_id, port, pid, cwd, started_at)
			SELECT COALESCE(session_id, 'legacy'), port, pid, cwd, started_at FROM daemon`,
		`DROP TABLE daemon`,
		`ALTER TABLE daemon_v2 RENAME TO daemon`,
	],
	5: [
		`CREATE TABLE IF NOT EXISTS spans (
			span_id TEXT PRIMARY KEY,
			trace_id TEXT NOT NULL,
			parent_span_id TEXT,
			name TEXT NOT NULL,
			kind INTEGER,
			start_time INTEGER NOT NULL,
			end_time INTEGER NOT NULL,
			status INTEGER,
			attributes TEXT,
			events TEXT,
			session_id TEXT)`,
		`CREATE INDEX IF NOT EXISTS idx_spans_trace ON spans(trace_id)`,
		`CREATE INDEX IF NOT EXISTS idx_spans_parent ON spans(parent_span_id)`,
		`CREATE INDEX IF NOT EXISTS idx_spans_session ON spans(session_id)`,
	],
	6: [
		`ALTER TABLE daemon ADD COLUMN host TEXT DEFAULT '127.0.0.1'`,
		`ALTER TABLE daemon ADD COLUMN last_heartbeat INTEGER`,
		`ALTER TABLE daemon ADD COLUMN token TEXT`,
	],
};

export async function applySchema(client: Client): Promise<void> {
	const version = await getSchemaVersion(client);
	if (version >= CURRENT_SCHEMA_VERSION) return;

	if (version === 0) {
		await client.batch(
			DDL_STATEMENTS.map((sql) => ({ sql, args: [] })),
			"write",
		);
		await client.execute({ sql: "INSERT INTO schema_version (version) VALUES (?)", args: [CURRENT_SCHEMA_VERSION] });
		return;
	}

	for (let v = version + 1; v <= CURRENT_SCHEMA_VERSION; v++) {
		const stmts = MIGRATIONS[v];
		// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- not all versions have migration entries
		if (stmts) {
			for (const sql of stmts) {
				try {
					await client.execute(sql);
				} catch {
					// Column may already exist from a partial migration
				}
			}
		}
	}
	await client.execute({ sql: "UPDATE schema_version SET version = ?", args: [CURRENT_SCHEMA_VERSION] });
}

async function getSchemaVersion(client: Client): Promise<number> {
	try {
		const result = await client.execute("SELECT version FROM schema_version LIMIT 1");
		const row = result.rows[0];
		// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- row may be undefined if table is empty
		return row ? Number(row.version) : 0;
	} catch {
		return 0;
	}
}
