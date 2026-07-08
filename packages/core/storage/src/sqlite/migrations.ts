import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@libsql/client";

/**
 *
 */
export async function ensureMigrationTable(client: Client): Promise<void> {
	await client.execute(`CREATE TABLE IF NOT EXISTS _plugin_migrations (
		plugin TEXT NOT NULL,
		version INTEGER NOT NULL,
		applied_at INTEGER NOT NULL,
		PRIMARY KEY (plugin, version)
	)`);
}

/**
 *
 */
export async function getPluginVersion(client: Client, plugin: string): Promise<number> {
	const r = await client.execute({
		sql: "SELECT MAX(version) as v FROM _plugin_migrations WHERE plugin = ?",
		args: [plugin],
	});
	const v = r.rows[0]?.v;
	return v != null ? Number(v) : 0;
}

/**
 *
 */
export async function runPluginMigrations(client: Client, plugin: string, migrationsDir: string): Promise<number> {
	await ensureMigrationTable(client);
	const current = await getPluginVersion(client, plugin);

	const files = readdirSync(migrationsDir)
		.filter((f) => f.endsWith(".sql"))
		.sort();

	let applied = 0;
	for (const file of files) {
		const match = file.match(/^(\d+)/);
		if (!match) continue;
		const version = Number.parseInt(match[1]!, 10);
		if (version <= current) continue;

		const sql = readFileSync(join(migrationsDir, file), "utf-8").trim();
		if (!sql) continue;

		const statements = sql.split(";").map((s) => s.trim()).filter(Boolean);
		for (const stmt of statements) {
			await client.execute(stmt);
		}

		await client.execute({
			sql: "INSERT INTO _plugin_migrations (plugin, version, applied_at) VALUES (?, ?, ?)",
			args: [plugin, version, Date.now()],
		});
		applied++;
	}

	return applied;
}
