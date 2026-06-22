import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { applySchema, CURRENT_SCHEMA_VERSION } from "../src/schema.js";

function memDb(): Database.Database {
	const db = new Database(":memory:");
	db.pragma("journal_mode = WAL");
	db.pragma("foreign_keys = ON");
	return db;
}

describe("schema", { tags: ["unit"] }, () => {
	it("creates all tables on fresh database", () => {
		const db = memDb();
		applySchema(db);

		const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
			name: string;
		}[];
		const names = tables.map((t) => t.name);

		expect(names).toContain("sessions");
		expect(names).toContain("events");
		expect(names).toContain("discourse_posts");
		expect(names).toContain("auth");
		expect(names).toContain("daemon");
		expect(names).toContain("session_summaries");
		expect(names).toContain("schema_version");
		db.close();
	});

	it("records schema version", () => {
		const db = memDb();
		applySchema(db);

		const row = db.prepare("SELECT version FROM schema_version").get() as { version: number };
		expect(row.version).toBe(CURRENT_SCHEMA_VERSION);
		db.close();
	});

	it("is idempotent", () => {
		const db = memDb();
		applySchema(db);
		applySchema(db);

		const row = db.prepare("SELECT version FROM schema_version").get() as { version: number };
		expect(row.version).toBe(CURRENT_SCHEMA_VERSION);
		db.close();
	});

	it("events table has identity dimension columns", () => {
		const db = memDb();
		applySchema(db);

		const cols = db.prepare("PRAGMA table_info(events)").all() as { name: string }[];
		const colNames = cols.map((c) => c.name);

		expect(colNames).toContain("session_id");
		expect(colNames).toContain("bus");
		expect(colNames).toContain("type");
		expect(colNames).toContain("correlation_id");
		expect(colNames).toContain("actor_address");
		expect(colNames).toContain("actor_type");
		expect(colNames).toContain("organ");
		expect(colNames).toContain("turn_number");
		expect(colNames).toContain("version");
		db.close();
	});

	it("can insert and query a session + event", () => {
		const db = memDb();
		applySchema(db);

		db.prepare("INSERT INTO sessions (id, cwd_hash, created_at, updated_at) VALUES (?, ?, ?, ?)").run(
			"abcd1234",
			"hash123",
			Date.now(),
			Date.now(),
		);

		db.prepare(
			`INSERT INTO events (session_id, bus, type, correlation_id, payload, timestamp, organ, turn_number, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run("abcd1234", "motor", "fs.read", "corr-1", '{"path":"/tmp"}', Date.now(), "fs", 1, "0.0.1");

		const events = db.prepare("SELECT * FROM events WHERE session_id = ?").all("abcd1234") as { type: string }[];
		expect(events).toHaveLength(1);
		expect(events[0].type).toBe("fs.read");
		db.close();
	});
});
