import type Database from "better-sqlite3";

export const CURRENT_SCHEMA_VERSION = 1;

const DDL = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  cwd_hash    TEXT NOT NULL,
  cwd         TEXT,
  name        TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  version     TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_cwd ON sessions(cwd_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at);

CREATE TABLE IF NOT EXISTS events (
  rowid           INTEGER PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions(id),
  bus             TEXT NOT NULL,
  type            TEXT NOT NULL,
  correlation_id  TEXT NOT NULL,
  payload         TEXT NOT NULL,
  timestamp       INTEGER NOT NULL,
  elapsed         INTEGER,
  hash            TEXT,
  actor_address   TEXT,
  actor_type      TEXT,
  organ           TEXT,
  turn_number     INTEGER,
  version         TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_correlation ON events(session_id, correlation_id);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(session_id, type);
CREATE INDEX IF NOT EXISTS idx_events_bus ON events(session_id, bus);
CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(session_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_events_organ ON events(session_id, organ);

CREATE TABLE IF NOT EXISTS discourse_posts (
  rowid       INTEGER PRIMARY KEY,
  session_id  TEXT NOT NULL,
  topic       TEXT NOT NULL,
  thread      TEXT NOT NULL,
  author      TEXT NOT NULL,
  content     TEXT NOT NULL,
  timestamp   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_discourse_thread ON discourse_posts(topic, thread);
CREATE INDEX IF NOT EXISTS idx_discourse_session ON discourse_posts(session_id);

CREATE TABLE IF NOT EXISTS auth (
  provider    TEXT PRIMARY KEY,
  type        TEXT NOT NULL DEFAULT 'api_key',
  key         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS daemon (
  id          INTEGER PRIMARY KEY DEFAULT 1,
  port        INTEGER NOT NULL,
  pid         INTEGER NOT NULL,
  session_id  TEXT,
  cwd         TEXT,
  started_at  INTEGER
);

CREATE TABLE IF NOT EXISTS session_summaries (
  session_id    TEXT PRIMARY KEY REFERENCES sessions(id),
  model         TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  duration_ms   INTEGER NOT NULL,
  turns         INTEGER NOT NULL,
  input_tokens  INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  tools         TEXT NOT NULL,
  errors        INTEGER NOT NULL
);
`;

export function applySchema(db: Database.Database): void {
	const version = getSchemaVersion(db);
	if (version >= CURRENT_SCHEMA_VERSION) return;

	db.exec(DDL);
	if (version === 0) {
		db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(CURRENT_SCHEMA_VERSION);
	} else {
		db.prepare("UPDATE schema_version SET version = ?").run(CURRENT_SCHEMA_VERSION);
	}
}

function getSchemaVersion(db: Database.Database): number {
	try {
		const row = db.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version: number } | undefined;
		return row?.version ?? 0;
	} catch {
		return 0;
	}
}
