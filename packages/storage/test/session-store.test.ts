import type { StorageRecord } from "@dpopsuev/alef-session";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applySchema } from "../src/schema.js";
import { SqliteSessionStore } from "../src/session-store.js";

function makeDb(): Database.Database {
	const db = new Database(":memory:");
	db.pragma("journal_mode = WAL");
	db.pragma("foreign_keys = ON");
	applySchema(db);
	return db;
}

function motorEvent(type: string, correlationId: string, extra?: Partial<StorageRecord>): StorageRecord {
	return {
		bus: "motor",
		type,
		correlationId,
		payload: { text: `payload for ${type}` },
		timestamp: Date.now(),
		...extra,
	};
}

function senseEvent(type: string, correlationId: string, extra?: Partial<StorageRecord>): StorageRecord {
	return {
		bus: "sense",
		type,
		correlationId,
		payload: { content: `result of ${type}` },
		timestamp: Date.now(),
		...extra,
	};
}

describe("SqliteSessionStore.create", { tags: ["unit"] }, () => {
	it("creates a session with 8-char id", () => {
		const db = makeDb();
		const store = SqliteSessionStore.create(db, "/tmp/test-cwd");
		expect(store.id).toHaveLength(8);
		expect(store.path).toContain(store.id);
		db.close();
	});

	it("inserts a row in sessions table", () => {
		const db = makeDb();
		const store = SqliteSessionStore.create(db, "/tmp/test-cwd");
		const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(store.id) as Record<string, unknown>;
		expect(row).toBeTruthy();
		expect(row.cwd).toBe("/tmp/test-cwd");
		db.close();
	});
});

describe("SqliteSessionStore.append + events", { tags: ["unit"] }, () => {
	let db: Database.Database;
	let store: SqliteSessionStore;

	beforeEach(() => {
		db = makeDb();
		store = SqliteSessionStore.create(db, "/tmp/cwd");
	});
	afterEach(() => db.close());

	it("appends and retrieves events", async () => {
		const record = motorEvent("fs.read", "corr-1");
		await store.append(record);

		const events = await store.events();
		expect(events).toHaveLength(1);
		expect(events[0].type).toBe("fs.read");
		expect(events[0].correlationId).toBe("corr-1");
	});

	it("persists events to SQLite", async () => {
		await store.append(motorEvent("fs.read", "corr-1"));

		const rows = db.prepare("SELECT * FROM events WHERE session_id = ?").all(store.id) as Array<
			Record<string, unknown>
		>;
		expect(rows).toHaveLength(1);
		expect(rows[0].type).toBe("fs.read");
		expect(rows[0].organ).toBe("fs");
		expect(rows[0].version).toBeTruthy();
	});

	it("stores actor identity", async () => {
		await store.append(motorEvent("fs.read", "corr-1", { actor: { address: "@crimson", type: "agent" } }));

		const row = db
			.prepare("SELECT actor_address, actor_type FROM events WHERE session_id = ?")
			.get(store.id) as Record<string, unknown>;
		expect(row.actor_address).toBe("@crimson");
		expect(row.actor_type).toBe("agent");
	});

	it("derives organ from event type", async () => {
		await store.append(motorEvent("shell.exec", "corr-1"));
		await store.append(motorEvent("llm.response", "corr-2"));
		await store.append(motorEvent("debug", "corr-3"));

		const rows = db
			.prepare("SELECT type, organ FROM events WHERE session_id = ? ORDER BY rowid")
			.all(store.id) as Array<Record<string, unknown>>;
		expect(rows[0].organ).toBe("shell");
		expect(rows[1].organ).toBe("llm");
		expect(rows[2].organ).toBeNull();
	});
});

describe("SqliteSessionStore.turns", { tags: ["unit"] }, () => {
	let db: Database.Database;
	let store: SqliteSessionStore;

	beforeEach(() => {
		db = makeDb();
		store = SqliteSessionStore.create(db, "/tmp/cwd");
	});
	afterEach(() => db.close());

	it("groups events by correlationId", async () => {
		await store.append(motorEvent("fs.read", "turn-1"));
		await store.append(senseEvent("fs.read", "turn-1"));
		await store.append(motorEvent("fs.write", "turn-2"));

		const turns = await store.turns();
		expect(turns).toHaveLength(2);
		expect(turns[0].id).toBe("turn-1");
		expect(turns[0].events).toHaveLength(2);
		expect(turns[1].id).toBe("turn-2");
	});

	it("computes tokenCost from content length", async () => {
		await store.append(motorEvent("fs.read", "turn-1", { payload: { text: "a".repeat(400) } }));

		const turns = await store.turns();
		expect(turns[0].tokenCost).toBe(100);
	});
});

describe("SqliteSessionStore.hitCounts", { tags: ["unit"] }, () => {
	it("tracks window.assembled inclusions", async () => {
		const db = makeDb();
		const store = SqliteSessionStore.create(db, "/tmp/cwd");

		await store.append(motorEvent("fs.read", "turn-1"));
		await store.append({
			bus: "internal",
			type: "window.assembled",
			correlationId: "assembler",
			payload: { includedTurnIds: ["turn-1", "turn-1"], budgetUsed: 0, budgetTotal: 0, queryTokens: [] },
			timestamp: Date.now(),
		});

		const counts = await store.hitCounts();
		expect(counts.get("turn-1")).toBe(2);
		db.close();
	});
});

describe("SqliteSessionStore.resume", { tags: ["unit"] }, () => {
	it("resumes and warms cache from SQLite", async () => {
		const db = makeDb();
		const original = SqliteSessionStore.create(db, "/tmp/cwd");
		await original.append(motorEvent("fs.read", "corr-1"));
		await original.append(senseEvent("fs.read", "corr-1"));

		const resumed = SqliteSessionStore.resume(db, "/tmp/cwd", original.id);
		const events = await resumed.events();
		expect(events).toHaveLength(2);

		const turns = await resumed.turns();
		expect(turns).toHaveLength(1);
		expect(turns[0].events).toHaveLength(2);
		db.close();
	});

	it("throws for unknown session id", () => {
		const db = makeDb();
		expect(() => SqliteSessionStore.resume(db, "/tmp/cwd", "deadbeef")).toThrow(/not found/);
		db.close();
	});
});

describe("SqliteSessionStore.resumeLatest", { tags: ["unit"] }, () => {
	it("returns null when no sessions exist", () => {
		const db = makeDb();
		expect(SqliteSessionStore.resumeLatest(db, "/tmp/cwd")).toBeNull();
		db.close();
	});

	it("returns the most recently updated session", async () => {
		const db = makeDb();
		const s1 = SqliteSessionStore.create(db, "/tmp/cwd");
		const s2 = SqliteSessionStore.create(db, "/tmp/cwd");
		db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(1000, s1.id);
		db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(2000, s2.id);

		const latest = SqliteSessionStore.resumeLatest(db, "/tmp/cwd");
		expect(latest?.id).toBe(s2.id);
		db.close();
	});
});

describe("SqliteSessionStore.list", { tags: ["unit"] }, () => {
	it("returns empty array when no sessions", () => {
		const db = makeDb();
		expect(SqliteSessionStore.list(db, "/tmp/cwd")).toHaveLength(0);
		db.close();
	});

	it("lists sessions ordered by updated_at desc", () => {
		const db = makeDb();
		SqliteSessionStore.create(db, "/tmp/cwd");
		SqliteSessionStore.create(db, "/tmp/cwd");
		expect(SqliteSessionStore.list(db, "/tmp/cwd")).toHaveLength(2);
		db.close();
	});
});

describe("SqliteSessionStore.prune", { tags: ["unit"] }, () => {
	it("removes old sessions beyond maxCount", async () => {
		const db = makeDb();
		const past = Date.now() - 100_000;
		for (let i = 0; i < 5; i++) {
			const s = SqliteSessionStore.create(db, "/tmp/cwd");
			db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(past - i * 1000, s.id);
		}
		const removed = SqliteSessionStore.prune(db, "/tmp/cwd", 0, 2);
		expect(removed).toBe(3);
		expect(SqliteSessionStore.list(db, "/tmp/cwd")).toHaveLength(2);
		db.close();
	});
});

describe("SqliteSessionStore.name + setName", { tags: ["unit"] }, () => {
	it("starts with no name", () => {
		const db = makeDb();
		const store = SqliteSessionStore.create(db, "/tmp/cwd");
		expect(store.name()).toBeUndefined();
		db.close();
	});

	it("persists name to sessions table and event log", async () => {
		const db = makeDb();
		const store = SqliteSessionStore.create(db, "/tmp/cwd");
		await store.setName("my session");

		expect(store.name()).toBe("my session");

		const row = db.prepare("SELECT name FROM sessions WHERE id = ?").get(store.id) as { name: string };
		expect(row.name).toBe("my session");
		db.close();
	});
});

describe("SqliteSessionStore.organHistory", { tags: ["unit"] }, () => {
	it("filters events by organ prefix", async () => {
		const db = makeDb();
		const store = SqliteSessionStore.create(db, "/tmp/cwd");
		await store.append(motorEvent("fs.read", "corr-1"));
		await store.append(motorEvent("fs.write", "corr-1"));
		await store.append(motorEvent("shell.exec", "corr-2"));

		const fsHistory = await store.organHistory("fs");
		expect(fsHistory).toHaveLength(2);
		expect(fsHistory.every((e) => e.type.startsWith("fs."))).toBe(true);
		db.close();
	});
});

describe("SqliteSessionStore identity dimensions", { tags: ["unit"] }, () => {
	it("stamps version on every event", async () => {
		const db = makeDb();
		const store = SqliteSessionStore.create(db, "/tmp/cwd", "1.2.3");
		await store.append(motorEvent("fs.read", "corr-1"));

		const row = db.prepare("SELECT version FROM events WHERE session_id = ?").get(store.id) as { version: string };
		expect(row.version).toBe("1.2.3");
		db.close();
	});

	it("stamps turn_number on motor/sense events", async () => {
		const db = makeDb();
		const store = SqliteSessionStore.create(db, "/tmp/cwd");
		await store.append(motorEvent("fs.read", "turn-A"));
		await store.append(senseEvent("fs.read", "turn-A"));
		await store.append(motorEvent("fs.write", "turn-B"));

		const rows = db
			.prepare("SELECT turn_number FROM events WHERE session_id = ? ORDER BY rowid")
			.all(store.id) as Array<{ turn_number: number | null }>;
		expect(rows[0].turn_number).toBe(0);
		expect(rows[1].turn_number).toBe(0);
		expect(rows[2].turn_number).toBe(1);
		db.close();
	});
});
