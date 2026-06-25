import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getDatabase, closeDatabase, openDatabase } from "../src/database.js";
import { SqliteSessionStore } from "../src/session-store.js";

describe("database boot smoke test", { tags: ["integration"] }, () => {
	let tempDir: string;

	afterEach(() => {
		closeDatabase();
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	});

	it("getDatabase boots with file-backed SQLite and all PRAGMAs", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "alef-boot-"));
		const dbPath = join(tempDir, "alef.db");

		const client = await getDatabase(dbPath);

		const wal = await client.execute("PRAGMA journal_mode");
		expect(String(wal.rows[0].journal_mode)).toBe("wal");

		const timeout = await client.execute("PRAGMA busy_timeout");
		expect(Number(timeout.rows[0].timeout)).toBe(5000);

		const sync = await client.execute("PRAGMA synchronous");
		expect(Number(sync.rows[0].synchronous)).toBe(1); // NORMAL = 1

		const fk = await client.execute("PRAGMA foreign_keys");
		expect(Number(fk.rows[0].foreign_keys)).toBe(1);
	});

	it("openDatabase boots with file-backed SQLite and all PRAGMAs", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "alef-boot-"));
		const dbPath = join(tempDir, "standalone.db");

		const client = await openDatabase(dbPath);

		const wal = await client.execute("PRAGMA journal_mode");
		expect(String(wal.rows[0].journal_mode)).toBe("wal");

		const timeout = await client.execute("PRAGMA busy_timeout");
		expect(Number(timeout.rows[0].timeout)).toBe(5000);

		const sync = await client.execute("PRAGMA synchronous");
		expect(Number(sync.rows[0].synchronous)).toBe(1);

		client.close();
	});

	it("can create a session and append events after boot", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "alef-boot-"));
		const dbPath = join(tempDir, "alef.db");

		const client = await getDatabase(dbPath);
		const store = await SqliteSessionStore.create(client, "/tmp/smoke-test");

		await store.append({
			bus: "command",
			type: "fs.read",
			correlationId: "smoke-1",
			payload: { path: "/tmp/hello" },
			timestamp: Date.now(),
		});

		const events = await store.events();
		expect(events).toHaveLength(1);
		expect(events[0].type).toBe("fs.read");
	});

	it("concurrent appends on the same file DB do not crash", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "alef-boot-"));
		const dbPath = join(tempDir, "alef.db");

		const client = await getDatabase(dbPath);
		const store = await SqliteSessionStore.create(client, "/tmp/concurrent");

		const writes = Array.from({ length: 20 }, (_, i) =>
			store.append({
				bus: "command",
				type: `tool.call-${i}`,
				correlationId: `corr-${i}`,
				payload: { index: i },
				timestamp: Date.now(),
			}),
		);

		await Promise.all(writes);

		const events = await store.events();
		expect(events).toHaveLength(20);
	});
});
