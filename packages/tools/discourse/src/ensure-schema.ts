import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "@libsql/client";
import { runPluginMigrations } from "@dpopsuev/alef-storage/sqlite/migrations";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../migrations");

/** Columns required by SqliteDiscourseStore (added after the original plugin table). */
const REQUIRED_COLUMNS: ReadonlyArray<{ name: string; ddl: string }> = [
	{ name: "id", ddl: "ALTER TABLE discourse_posts ADD COLUMN id TEXT" },
	{ name: "reply_to_post_id", ddl: "ALTER TABLE discourse_posts ADD COLUMN reply_to_post_id TEXT" },
	{
		name: "references_json",
		ddl: "ALTER TABLE discourse_posts ADD COLUMN references_json TEXT NOT NULL DEFAULT '[]'",
	},
];

/** Upgrade legacy discourse_posts (session_id/topic/… only) when migration 001 already applied. */
async function upgradeLegacyDiscourseColumns(client: Client): Promise<void> {
	const table = await client.execute(
		"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'discourse_posts'",
	);
	if (table.rows.length === 0) return;

	const info = await client.execute("PRAGMA table_info(discourse_posts)");
	const columns = new Set(
		info.rows.map((row) => (typeof row.name === "string" ? row.name : "")).filter(Boolean),
	);

	for (const column of REQUIRED_COLUMNS) {
		if (!columns.has(column.name)) {
			await client.execute(column.ddl);
		}
	}
}

/** Apply discourse plugin DDL (`discourse_posts`) to the session database. */
export async function ensureDiscourseSchema(client: Client): Promise<void> {
	await runPluginMigrations(client, "discourse", MIGRATIONS_DIR);
	await upgradeLegacyDiscourseColumns(client);
}
