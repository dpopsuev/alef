import { type Client, createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { applySchema, CURRENT_SCHEMA_VERSION } from "../src/schema.js";

async function makeClient(): Promise<Client> {
	const client = createClient({ url: ":memory:" });
	return client;
}

describe("schema", { tags: ["unit"] }, () => {
	const clients: Client[] = [];
	afterEach(() => {
		for (const c of clients.splice(0)) c.close();
	});

	it("creates all tables on fresh database", async () => {
		const client = await makeClient();
		clients.push(client);
		await applySchema(client);

		const result = await client.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
		const names = result.rows.map((r) => String(r.name));

		expect(names).toContain("sessions");
		expect(names).toContain("events");
		expect(names).toContain("discourse_posts");
		expect(names).toContain("auth");
		expect(names).toContain("daemon");
		expect(names).toContain("session_summaries");
		expect(names).toContain("schema_version");
	});

	it("records schema version", async () => {
		const client = await makeClient();
		clients.push(client);
		await applySchema(client);

		const result = await client.execute("SELECT version FROM schema_version");
		expect(Number(result.rows[0].version)).toBe(CURRENT_SCHEMA_VERSION);
	});

	it("is idempotent", async () => {
		const client = await makeClient();
		clients.push(client);
		await applySchema(client);
		await applySchema(client);

		const result = await client.execute("SELECT version FROM schema_version");
		expect(Number(result.rows[0].version)).toBe(CURRENT_SCHEMA_VERSION);
	});

	it("events table has identity dimension columns", async () => {
		const client = await makeClient();
		clients.push(client);
		await applySchema(client);

		const result = await client.execute("PRAGMA table_info(events)");
		const colNames = result.rows.map((c) => String(c.name));

		expect(colNames).toContain("session_id");
		expect(colNames).toContain("bus");
		expect(colNames).toContain("type");
		expect(colNames).toContain("correlation_id");
		expect(colNames).toContain("actor_address");
		expect(colNames).toContain("actor_type");
		expect(colNames).toContain("adapter");
		expect(colNames).toContain("turn_number");
		expect(colNames).toContain("version");
	});

	it("migrates v2 schema — renames organ column to adapter", async () => {
		const client = await makeClient();
		clients.push(client);

		// Seed a v2 database: events table with 'organ' column, no 'adapter'
		await client.batch([
			{ sql: `CREATE TABLE schema_version (version INTEGER NOT NULL)`, args: [] },
			{ sql: `INSERT INTO schema_version (version) VALUES (2)`, args: [] },
			{ sql: `CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd_hash TEXT NOT NULL, cwd TEXT, name TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, version TEXT)`, args: [] },
			{ sql: `CREATE TABLE events (
				rowid INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
				bus TEXT NOT NULL, type TEXT NOT NULL, correlation_id TEXT NOT NULL,
				payload TEXT NOT NULL, timestamp INTEGER NOT NULL, elapsed INTEGER,
				hash TEXT, actor_address TEXT, actor_type TEXT, organ TEXT,
				turn_number INTEGER, version TEXT, embedding BLOB)`, args: [] },
			{ sql: `CREATE TABLE discourse_posts (rowid INTEGER PRIMARY KEY, session_id TEXT NOT NULL, topic TEXT NOT NULL, thread TEXT NOT NULL, author TEXT NOT NULL, content TEXT NOT NULL, timestamp INTEGER NOT NULL)`, args: [] },
			{ sql: `CREATE TABLE auth (provider TEXT PRIMARY KEY, type TEXT NOT NULL DEFAULT 'api_key', key TEXT NOT NULL)`, args: [] },
			{ sql: `CREATE TABLE daemon (id INTEGER PRIMARY KEY DEFAULT 1, port INTEGER NOT NULL, pid INTEGER NOT NULL, session_id TEXT, cwd TEXT, started_at INTEGER)`, args: [] },
			{ sql: `CREATE TABLE session_summaries (session_id TEXT PRIMARY KEY REFERENCES sessions(id), model TEXT NOT NULL, started_at TEXT NOT NULL, duration_ms INTEGER NOT NULL, turns INTEGER NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, tools TEXT NOT NULL, errors INTEGER NOT NULL, embedding BLOB)`, args: [] },
		], "write");

		// Insert a row with old 'organ' column
		await client.execute({ sql: "INSERT INTO sessions (id, cwd_hash, created_at, updated_at) VALUES (?, ?, ?, ?)", args: ["s1", "h1", 1000, 1000] });
		await client.execute({
			sql: "INSERT INTO events (session_id, bus, type, correlation_id, payload, timestamp, organ) VALUES (?, ?, ?, ?, ?, ?, ?)",
			args: ["s1", "command", "fs.read", "c1", '{}', 1000, "fs"],
		});

		// Run migration
		await applySchema(client);

		// Verify version bumped
		const ver = await client.execute("SELECT version FROM schema_version");
		expect(Number(ver.rows[0].version)).toBe(CURRENT_SCHEMA_VERSION);

		// Verify column renamed: 'adapter' exists, 'organ' does not
		const cols = await client.execute("PRAGMA table_info(events)");
		const colNames = cols.rows.map((c) => String(c.name));
		expect(colNames).toContain("adapter");
		expect(colNames).not.toContain("organ");

		// Verify data preserved after rename
		const rows = await client.execute("SELECT adapter FROM events WHERE session_id = 's1'");
		expect(String(rows.rows[0].adapter)).toBe("fs");
	});

	it("can insert and query a session + event", async () => {
		const client = await makeClient();
		clients.push(client);
		await applySchema(client);

		await client.execute({
			sql: "INSERT INTO sessions (id, cwd_hash, created_at, updated_at) VALUES (?, ?, ?, ?)",
			args: ["abcd1234", "hash123", Date.now(), Date.now()],
		});

		await client.execute({
			sql: `INSERT INTO events (session_id, bus, type, correlation_id, payload, timestamp, adapter, turn_number, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			args: ["abcd1234", "motor", "fs.read", "corr-1", '{"path":"/tmp"}', Date.now(), "fs", 1, "0.0.1"],
		});

		const result = await client.execute({
			sql: "SELECT * FROM events WHERE session_id = ?",
			args: ["abcd1234"],
		});
		expect(result.rows).toHaveLength(1);
		expect(String(result.rows[0].type)).toBe("fs.read");
	});
});
