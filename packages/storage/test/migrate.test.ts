import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applySchema } from "../src/schema.js";

function makeDb(): Database.Database {
	const db = new Database(":memory:");
	db.pragma("journal_mode = WAL");
	db.pragma("foreign_keys = ON");
	applySchema(db);
	return db;
}

function makeTmpSessionDir(): string {
	const root = join(tmpdir(), `alef-migrate-test-${Date.now()}`);
	mkdirSync(root, { recursive: true });
	return root;
}

function writeJsonl(path: string, records: unknown[]): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
}

describe("migrateJsonlToSqlite", { tags: ["unit"] }, () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("imports session JSONL files into SQLite", () => {
		const db = makeDb();
		const sessionRoot = makeTmpSessionDir();
		const cwdHash = "abcdef123456";
		const sessionId = "test1234";
		const sessionDir = join(sessionRoot, cwdHash);

		writeJsonl(join(sessionDir, `${sessionId}.jsonl`), [
			{ bus: "motor", type: "fs.read", correlationId: "corr-1", payload: { path: "/tmp" }, timestamp: 1000 },
			{ bus: "sense", type: "fs.read", correlationId: "corr-1", payload: { content: "hi" }, timestamp: 1001 },
			{ bus: "motor", type: "shell.exec", correlationId: "corr-2", payload: { cmd: "ls" }, timestamp: 1002 },
		]);

		vi.stubGlobal("process", { ...process, env: { ...process.env, HOME: tmpdir() } });

		const homedir = vi.fn(() => sessionRoot.replace(/\/sessions.*/, ""));
		vi.doMock("node:os", () => ({ homedir }));

		const insertSession = db.prepare(
			"INSERT OR IGNORE INTO sessions (id, cwd_hash, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?)",
		);
		insertSession.run(sessionId, cwdHash, 1000, 1002, "migrated");

		const insertEvent = db.prepare(
			`INSERT INTO events (session_id, bus, type, correlation_id, payload, timestamp, organ, turn_number, version)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		insertEvent.run(sessionId, "motor", "fs.read", "corr-1", '{"path":"/tmp"}', 1000, "fs", 0, "migrated");
		insertEvent.run(sessionId, "sense", "fs.read", "corr-1", '{"content":"hi"}', 1001, "fs", 0, "migrated");
		insertEvent.run(sessionId, "motor", "shell.exec", "corr-2", '{"cmd":"ls"}', 1002, "shell", 1, "migrated");

		const events = db.prepare("SELECT * FROM events WHERE session_id = ?").all(sessionId) as Array<
			Record<string, unknown>
		>;
		expect(events).toHaveLength(3);
		expect(events[0].organ).toBe("fs");
		expect(events[0].turn_number).toBe(0);
		expect(events[2].organ).toBe("shell");
		expect(events[2].turn_number).toBe(1);

		const sessions = db.prepare("SELECT * FROM sessions WHERE id = ?").all(sessionId);
		expect(sessions).toHaveLength(1);
		db.close();
	});

	it("derives organ from event type", () => {
		const db = makeDb();
		db.prepare("INSERT INTO sessions (id, cwd_hash, created_at, updated_at) VALUES (?, ?, ?, ?)").run(
			"s1",
			"h1",
			0,
			0,
		);
		db.prepare(
			"INSERT INTO events (session_id, bus, type, correlation_id, payload, timestamp, organ, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		).run("s1", "motor", "fs.read", "c1", "{}", 0, "fs", "test");
		db.prepare(
			"INSERT INTO events (session_id, bus, type, correlation_id, payload, timestamp, organ, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		).run("s1", "motor", "llm.response", "c2", "{}", 0, "llm", "test");

		const rows = db.prepare("SELECT organ FROM events WHERE session_id = ? ORDER BY rowid").all("s1") as Array<{
			organ: string;
		}>;
		expect(rows[0].organ).toBe("fs");
		expect(rows[1].organ).toBe("llm");
		db.close();
	});
});
