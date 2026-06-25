import type { StorageRecord } from "@dpopsuev/alef-session";
import { type Client, createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applySchema } from "../src/schema.js";
import { SqliteSessionStore } from "../src/sqlite-session.js";

async function makeClient(): Promise<Client> {
	const client = createClient({ url: ":memory:" });
	await applySchema(client);
	return client;
}

function motorEvent(type: string, correlationId: string, extra?: Partial<StorageRecord>): StorageRecord {
	return {
		bus: "command",
		type,
		correlationId,
		payload: { text: `payload for ${type}` },
		timestamp: Date.now(),
		...extra,
	};
}

function senseEvent(type: string, correlationId: string, extra?: Partial<StorageRecord>): StorageRecord {
	return {
		bus: "event",
		type,
		correlationId,
		payload: { content: `result of ${type}` },
		timestamp: Date.now(),
		...extra,
	};
}

describe("SqliteSessionStore.create", { tags: ["unit"] }, () => {
	it("creates a session with 8-char id", async () => {
		const client = await makeClient();
		const store = await SqliteSessionStore.create(client, "/tmp/test-cwd");
		expect(store.id).toHaveLength(8);
		expect(store.path).toContain(store.id);
		client.close();
	});

	it("inserts a row in sessions table", async () => {
		const client = await makeClient();
		const store = await SqliteSessionStore.create(client, "/tmp/test-cwd");
		const result = await client.execute({
			sql: "SELECT * FROM sessions WHERE id = ?",
			args: [store.id],
		});
		const row = result.rows[0];
		expect(row).toBeTruthy();
		expect(String(row.cwd)).toBe("/tmp/test-cwd");
		client.close();
	});
});

describe("SqliteSessionStore.append + events", { tags: ["unit"] }, () => {
	let client: Client;
	let store: SqliteSessionStore;

	beforeEach(async () => {
		client = await makeClient();
		store = await SqliteSessionStore.create(client, "/tmp/cwd");
	});
	afterEach(() => client.close());

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

		const result = await client.execute({
			sql: "SELECT * FROM events WHERE session_id = ?",
			args: [store.id],
		});
		const rows = result.rows;
		expect(rows).toHaveLength(1);
		expect(String(rows[0].type)).toBe("fs.read");
		expect(String(rows[0].adapter)).toBe("fs");
		expect(rows[0].version).toBeTruthy();
	});

	it("stores actor identity", async () => {
		await store.append(motorEvent("fs.read", "corr-1", { actor: { address: "@crimson", type: "agent" } }));

		const result = await client.execute({
			sql: "SELECT actor_address, actor_type FROM events WHERE session_id = ?",
			args: [store.id],
		});
		const row = result.rows[0];
		expect(String(row.actor_address)).toBe("@crimson");
		expect(String(row.actor_type)).toBe("agent");
	});

	it("derives adapter from event type", async () => {
		await store.append(motorEvent("shell.exec", "corr-1"));
		await store.append(motorEvent("llm.response", "corr-2"));
		await store.append(motorEvent("debug", "corr-3"));

		const result = await client.execute({
			sql: "SELECT type, adapter FROM events WHERE session_id = ? ORDER BY rowid",
			args: [store.id],
		});
		const rows = result.rows;
		expect(String(rows[0].adapter)).toBe("shell");
		expect(String(rows[1].adapter)).toBe("llm");
		expect(rows[2].adapter).toBeNull();
	});
});

describe("SqliteSessionStore.turns", { tags: ["unit"] }, () => {
	let client: Client;
	let store: SqliteSessionStore;

	beforeEach(async () => {
		client = await makeClient();
		store = await SqliteSessionStore.create(client, "/tmp/cwd");
	});
	afterEach(() => client.close());

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
		const client = await makeClient();
		const store = await SqliteSessionStore.create(client, "/tmp/cwd");

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
		client.close();
	});
});

describe("SqliteSessionStore.resume", { tags: ["unit"] }, () => {
	it("resumes and warms cache from SQLite", async () => {
		const client = await makeClient();
		const original = await SqliteSessionStore.create(client, "/tmp/cwd");
		await original.append(motorEvent("fs.read", "corr-1"));
		await original.append(senseEvent("fs.read", "corr-1"));

		const resumed = await SqliteSessionStore.resume(client, "/tmp/cwd", original.id);
		const events = await resumed.events();
		expect(events).toHaveLength(2);

		const turns = await resumed.turns();
		expect(turns).toHaveLength(1);
		expect(turns[0].events).toHaveLength(2);
		client.close();
	});

	it("throws for unknown session id", async () => {
		const client = await makeClient();
		await expect(SqliteSessionStore.resume(client, "/tmp/cwd", "deadbeef")).rejects.toThrow(/not found/);
		client.close();
	});
});

describe("SqliteSessionStore.resumeLatest", { tags: ["unit"] }, () => {
	it("returns null when no sessions exist", async () => {
		const client = await makeClient();
		expect(await SqliteSessionStore.resumeLatest(client, "/tmp/cwd")).toBeNull();
		client.close();
	});

	it("returns the most recently updated session", async () => {
		const client = await makeClient();
		const s1 = await SqliteSessionStore.create(client, "/tmp/cwd");
		const s2 = await SqliteSessionStore.create(client, "/tmp/cwd");
		await client.execute({ sql: "UPDATE sessions SET updated_at = ? WHERE id = ?", args: [1000, s1.id] });
		await client.execute({ sql: "UPDATE sessions SET updated_at = ? WHERE id = ?", args: [2000, s2.id] });

		const latest = await SqliteSessionStore.resumeLatest(client, "/tmp/cwd");
		expect(latest?.id).toBe(s2.id);
		client.close();
	});
});

describe("SqliteSessionStore.list", { tags: ["unit"] }, () => {
	it("returns empty array when no sessions", async () => {
		const client = await makeClient();
		expect(await SqliteSessionStore.list(client, "/tmp/cwd")).toHaveLength(0);
		client.close();
	});

	it("lists sessions ordered by updated_at desc", async () => {
		const client = await makeClient();
		await SqliteSessionStore.create(client, "/tmp/cwd");
		await SqliteSessionStore.create(client, "/tmp/cwd");
		expect(await SqliteSessionStore.list(client, "/tmp/cwd")).toHaveLength(2);
		client.close();
	});
});

describe("SqliteSessionStore.prune", { tags: ["unit"] }, () => {
	it("removes old sessions beyond maxCount", async () => {
		const client = await makeClient();
		const past = Date.now() - 100_000;
		for (let i = 0; i < 5; i++) {
			const s = await SqliteSessionStore.create(client, "/tmp/cwd");
			await client.execute({
				sql: "UPDATE sessions SET updated_at = ? WHERE id = ?",
				args: [past - i * 1000, s.id],
			});
		}
		const removed = await SqliteSessionStore.prune(client, "/tmp/cwd", 0, 2);
		expect(removed).toBe(3);
		expect(await SqliteSessionStore.list(client, "/tmp/cwd")).toHaveLength(2);
		client.close();
	});
});

describe("SqliteSessionStore.name + setName", { tags: ["unit"] }, () => {
	it("starts with no name", async () => {
		const client = await makeClient();
		const store = await SqliteSessionStore.create(client, "/tmp/cwd");
		expect(store.name()).toBeUndefined();
		client.close();
	});

	it("persists name to sessions table and event log", async () => {
		const client = await makeClient();
		const store = await SqliteSessionStore.create(client, "/tmp/cwd");
		await store.setName("my session");

		expect(store.name()).toBe("my session");

		const result = await client.execute({
			sql: "SELECT name FROM sessions WHERE id = ?",
			args: [store.id],
		});
		const row = result.rows[0];
		expect(String(row.name)).toBe("my session");
		client.close();
	});
});

describe("SqliteSessionStore.adapterHistory", { tags: ["unit"] }, () => {
	it("filters events by adapter prefix", async () => {
		const client = await makeClient();
		const store = await SqliteSessionStore.create(client, "/tmp/cwd");
		await store.append(motorEvent("fs.read", "corr-1"));
		await store.append(motorEvent("fs.write", "corr-1"));
		await store.append(motorEvent("shell.exec", "corr-2"));

		const fsHistory = await store.adapterHistory("fs");
		expect(fsHistory).toHaveLength(2);
		expect(fsHistory.every((e) => e.type.startsWith("fs."))).toBe(true);
		client.close();
	});
});

describe("SqliteSessionStore identity dimensions", { tags: ["unit"] }, () => {
	it("stamps version on every event", async () => {
		const client = await makeClient();
		const store = await SqliteSessionStore.create(client, "/tmp/cwd", "1.2.3");
		await store.append(motorEvent("fs.read", "corr-1"));

		const result = await client.execute({
			sql: "SELECT version FROM events WHERE session_id = ?",
			args: [store.id],
		});
		const row = result.rows[0];
		expect(String(row.version)).toBe("1.2.3");
		client.close();
	});

	it("stamps turn_number on motor/sense events", async () => {
		const client = await makeClient();
		const store = await SqliteSessionStore.create(client, "/tmp/cwd");
		await store.append(motorEvent("fs.read", "turn-A"));
		await store.append(senseEvent("fs.read", "turn-A"));
		await store.append(motorEvent("fs.write", "turn-B"));

		const result = await client.execute({
			sql: "SELECT turn_number FROM events WHERE session_id = ? ORDER BY rowid",
			args: [store.id],
		});
		const rows = result.rows;
		expect(Number(rows[0].turn_number)).toBe(0);
		expect(Number(rows[1].turn_number)).toBe(0);
		expect(Number(rows[2].turn_number)).toBe(1);
		client.close();
	});
});
