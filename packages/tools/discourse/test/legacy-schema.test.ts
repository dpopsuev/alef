/**
 * Repro: existing alef.db has discourse_posts without `id` (pre-session-store shape),
 * while plugin migration version is already 1 so CREATE TABLE IF NOT EXISTS is a no-op.
 * Boot → context.assemble → readNewPosts → SQLITE_ERROR: no such column: id → process exit.
 */

import { type Client, createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { createDiscourseAdapter } from "../src/adapter.js";
import { ensureDiscourseSchema } from "../src/ensure-schema.js";
import { openDiscourseBackend } from "../src/open-backend.js";
import { SqliteDiscourseStore } from "../src/sqlite-store.js";

/** Match production ~/.local/share/alef/alef.db discourse_posts (2026-07 observed). */
async function seedLegacyDiscourseDb(client: Client): Promise<void> {
	await client.execute(`CREATE TABLE discourse_posts (
		rowid INTEGER PRIMARY KEY,
		session_id TEXT NOT NULL,
		topic TEXT NOT NULL,
		thread TEXT NOT NULL,
		author TEXT NOT NULL,
		content TEXT NOT NULL,
		timestamp INTEGER NOT NULL
	)`);
	await client.execute(`CREATE TABLE _plugin_migrations (
		plugin TEXT NOT NULL,
		version INTEGER NOT NULL,
		applied_at INTEGER NOT NULL,
		PRIMARY KEY (plugin, version)
	)`);
	await client.execute({
		sql: "INSERT INTO _plugin_migrations (plugin, version, applied_at) VALUES (?, ?, ?)",
		args: ["discourse", 1, Date.now()],
	});
	await client.execute({
		sql: "INSERT INTO discourse_posts (session_id, topic, thread, author, content, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
		args: ["sess-legacy", "alef", "topic-1", "@user", JSON.stringify("hello"), Date.now() - 1000],
	});
}

describe("legacy discourse_posts schema (no id column)", { tags: ["unit"] }, () => {
	const clients: Client[] = [];

	afterEach(() => {
		for (const client of clients.splice(0)) client.close();
	});

	it("readNewPosts after ensureDiscourseSchema does not throw no such column: id", async () => {
		const client = createClient({ url: ":memory:" });
		clients.push(client);
		await seedLegacyDiscourseDb(client);

		const colsBefore = await client.execute("PRAGMA table_info(discourse_posts)");
		expect(colsBefore.rows.map((r) => String(r.name))).not.toContain("id");

		await ensureDiscourseSchema(client);

		const store = new SqliteDiscourseStore(client, "sess-legacy");
		const posts = await store.readNewPosts(0);
		expect(posts.length).toBeGreaterThanOrEqual(1);
		expect(posts[0]?.author).toBe("@user");
	});

	it("openDiscourseBackend + context.assemble survives legacy schema (boot crash path)", async () => {
		const client = createClient({ url: ":memory:" });
		clients.push(client);
		await seedLegacyDiscourseDb(client);

		const backend = await openDiscourseBackend({ client, sessionId: "sess-legacy" });
		const adapter = createDiscourseAdapter({ backend, actorAddress: "@agent" });
		const stage = adapter.contributions?.["context.assemble"];
		expect(stage).toBeTypeOf("function");

		await expect(
			stage!({
				messages: [{ role: "user", content: "hi" }],
				tools: [],
				turn: 1,
			}),
		).resolves.toBeDefined();
	});
});
