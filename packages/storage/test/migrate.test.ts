import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Client, createClient } from "@libsql/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applySchema } from "../src/schema.js";

async function makeClient(): Promise<Client> {
	const client = createClient({ url: ":memory:" });
	await applySchema(client);
	return client;
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

	it("imports session JSONL files into SQLite", async () => {
		const client = await makeClient();
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

		await client.execute({
			sql: "INSERT OR IGNORE INTO sessions (id, cwd_hash, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?)",
			args: [sessionId, cwdHash, 1000, 1002, "migrated"],
		});

		await client.execute({
			sql: `INSERT INTO events (session_id, bus, type, correlation_id, payload, timestamp, organ, turn_number, version)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			args: [sessionId, "motor", "fs.read", "corr-1", '{"path":"/tmp"}', 1000, "fs", 0, "migrated"],
		});
		await client.execute({
			sql: `INSERT INTO events (session_id, bus, type, correlation_id, payload, timestamp, organ, turn_number, version)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			args: [sessionId, "sense", "fs.read", "corr-1", '{"content":"hi"}', 1001, "fs", 0, "migrated"],
		});
		await client.execute({
			sql: `INSERT INTO events (session_id, bus, type, correlation_id, payload, timestamp, organ, turn_number, version)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			args: [sessionId, "motor", "shell.exec", "corr-2", '{"cmd":"ls"}', 1002, "shell", 1, "migrated"],
		});

		const eventsResult = await client.execute({
			sql: "SELECT * FROM events WHERE session_id = ?",
			args: [sessionId],
		});
		const events = eventsResult.rows;
		expect(events).toHaveLength(3);
		expect(String(events[0].organ)).toBe("fs");
		expect(Number(events[0].turn_number)).toBe(0);
		expect(String(events[2].organ)).toBe("shell");
		expect(Number(events[2].turn_number)).toBe(1);

		const sessionsResult = await client.execute({
			sql: "SELECT * FROM sessions WHERE id = ?",
			args: [sessionId],
		});
		expect(sessionsResult.rows).toHaveLength(1);
		client.close();
	});

	it("derives organ from event type", async () => {
		const client = await makeClient();
		await client.execute({
			sql: "INSERT INTO sessions (id, cwd_hash, created_at, updated_at) VALUES (?, ?, ?, ?)",
			args: ["s1", "h1", 0, 0],
		});
		await client.execute({
			sql: "INSERT INTO events (session_id, bus, type, correlation_id, payload, timestamp, organ, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			args: ["s1", "motor", "fs.read", "c1", "{}", 0, "fs", "test"],
		});
		await client.execute({
			sql: "INSERT INTO events (session_id, bus, type, correlation_id, payload, timestamp, organ, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			args: ["s1", "motor", "llm.response", "c2", "{}", 0, "llm", "test"],
		});

		const result = await client.execute({
			sql: "SELECT organ FROM events WHERE session_id = ? ORDER BY rowid",
			args: ["s1"],
		});
		const rows = result.rows;
		expect(String(rows[0].organ)).toBe("fs");
		expect(String(rows[1].organ)).toBe("llm");
		client.close();
	});
});
