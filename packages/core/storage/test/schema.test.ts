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
