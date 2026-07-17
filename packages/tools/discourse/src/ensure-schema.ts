import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "@libsql/client";
import { runPluginMigrations } from "@dpopsuev/alef-storage/sqlite/migrations";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../migrations");

/** Apply discourse plugin DDL (`discourse_posts`) to the session database. */
export async function ensureDiscourseSchema(client: Client): Promise<void> {
	await runPluginMigrations(client, "discourse", MIGRATIONS_DIR);
}
