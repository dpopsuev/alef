import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTestDatabase } from "../src/sqlite/database.js";
import { getPluginVersion, runPluginMigrations } from "../src/sqlite/migrations.js";

describe("plugin migrations", { tags: ["integration"] }, () => {
	const cleanups: Array<() => void> = [];
	let tempDir: string;

	afterEach(() => {
		for (const fn of cleanups.splice(0)) fn();
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	});

	function createMigrationDir(files: Record<string, string>): string {
		tempDir = mkdtempSync(join(tmpdir(), "alef-migrations-"));
		const dir = join(tempDir, "migrations");
		mkdirSync(dir);
		for (const [name, sql] of Object.entries(files)) {
			writeFileSync(join(dir, name), sql);
		}
		return dir;
	}

	it("runs numbered SQL migrations in order", async () => {
		const { client, cleanup } = await makeTestDatabase();
		cleanups.push(cleanup);

		const dir = createMigrationDir({
			"001_create_foo.sql": "CREATE TABLE foo (id INTEGER PRIMARY KEY, name TEXT)",
			"002_add_column.sql": "ALTER TABLE foo ADD COLUMN age INTEGER",
		});

		const applied = await runPluginMigrations(client, "test-plugin", dir);
		expect(applied).toBe(2);

		const version = await getPluginVersion(client, "test-plugin");
		expect(version).toBe(2);

		await client.execute({ sql: "INSERT INTO foo (name, age) VALUES (?, ?)", args: ["alice", 30] });
		const r = await client.execute("SELECT * FROM foo");
		expect(r.rows).toHaveLength(1);
	});

	it("skips already-applied migrations", async () => {
		const { client, cleanup } = await makeTestDatabase();
		cleanups.push(cleanup);

		const dir = createMigrationDir({
			"001_create.sql": "CREATE TABLE bar (id INTEGER PRIMARY KEY)",
		});

		await runPluginMigrations(client, "test-plugin", dir);
		const applied = await runPluginMigrations(client, "test-plugin", dir);
		expect(applied).toBe(0);
	});

	it("tracks versions per plugin independently", async () => {
		const { client, cleanup } = await makeTestDatabase();
		cleanups.push(cleanup);

		const dirA = createMigrationDir({
			"001_a.sql": "CREATE TABLE plugin_a (id INTEGER PRIMARY KEY)",
		});
		const dirB = join(tempDir, "migrations_b");
		mkdirSync(dirB);
		writeFileSync(join(dirB, "001_b.sql"), "CREATE TABLE plugin_b (id INTEGER PRIMARY KEY)");
		writeFileSync(join(dirB, "002_b.sql"), "ALTER TABLE plugin_b ADD COLUMN val TEXT");

		await runPluginMigrations(client, "plugin-a", dirA);
		await runPluginMigrations(client, "plugin-b", dirB);

		expect(await getPluginVersion(client, "plugin-a")).toBe(1);
		expect(await getPluginVersion(client, "plugin-b")).toBe(2);
	});

	it("returns 0 applied for empty directory", async () => {
		const { client, cleanup } = await makeTestDatabase();
		cleanups.push(cleanup);

		const dir = createMigrationDir({});
		const applied = await runPluginMigrations(client, "empty", dir);
		expect(applied).toBe(0);
	});
});
