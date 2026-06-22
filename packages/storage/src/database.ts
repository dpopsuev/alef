import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { migrateJsonlToSqlite, needsMigration } from "./migrate.js";
import { applySchema } from "./schema.js";

let _db: Database.Database | undefined;

export function getDatabase(path?: string): Database.Database {
	if (_db) return _db;
	const dbPath = path ?? join(homedir(), ".alef", "alef.db");
	mkdirSync(dirname(dbPath), { recursive: true });
	_db = new Database(dbPath);
	_db.pragma("journal_mode = WAL");
	_db.pragma("synchronous = NORMAL");
	_db.pragma("foreign_keys = ON");
	applySchema(_db);

	if (needsMigration(_db)) {
		const result = migrateJsonlToSqlite(_db);
		if (result.sessions > 0) {
			process.stderr.write(
				`[storage] Migrated ${result.sessions} sessions (${result.events} events) from JSONL to SQLite\n`,
			);
		}
	}

	return _db;
}

export function closeDatabase(): void {
	_db?.close();
	_db = undefined;
}

export function openDatabase(path: string): Database.Database {
	mkdirSync(dirname(path), { recursive: true });
	const db = new Database(path);
	db.pragma("journal_mode = WAL");
	db.pragma("synchronous = NORMAL");
	db.pragma("foreign_keys = ON");
	applySchema(db);
	return db;
}
