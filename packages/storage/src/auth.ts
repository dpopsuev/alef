import type Database from "better-sqlite3";

export class SqliteAuthStore {
	private readonly db: Database.Database;

	constructor(db: Database.Database) {
		this.db = db;
	}

	get(provider: string): string | undefined {
		const row = this.db.prepare("SELECT key FROM auth WHERE provider = ?").get(provider) as
			| { key: string }
			| undefined;
		return row?.key;
	}

	set(provider: string, key: string): void {
		this.db
			.prepare(
				"INSERT INTO auth (provider, type, key) VALUES (?, 'api_key', ?) ON CONFLICT(provider) DO UPDATE SET key = excluded.key",
			)
			.run(provider, key);
	}

	remove(provider: string): void {
		this.db.prepare("DELETE FROM auth WHERE provider = ?").run(provider);
	}

	list(): Array<{ provider: string; type: string }> {
		return this.db.prepare("SELECT provider, type FROM auth ORDER BY provider").all() as Array<{
			provider: string;
			type: string;
		}>;
	}
}
