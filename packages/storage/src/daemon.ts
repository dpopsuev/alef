import type Database from "better-sqlite3";

export interface DaemonEntry {
	port: number;
	pid: number;
	sessionId?: string;
	cwd?: string;
	startedAt?: number;
}

export class SqliteDaemonStore {
	private readonly db: Database.Database;

	constructor(db: Database.Database) {
		this.db = db;
	}

	set(entry: DaemonEntry): void {
		this.db
			.prepare(
				`INSERT INTO daemon (id, port, pid, session_id, cwd, started_at)
				 VALUES (1, ?, ?, ?, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET port = excluded.port, pid = excluded.pid,
				   session_id = excluded.session_id, cwd = excluded.cwd, started_at = excluded.started_at`,
			)
			.run(entry.port, entry.pid, entry.sessionId ?? null, entry.cwd ?? null, entry.startedAt ?? null);
	}

	get(): DaemonEntry | undefined {
		const row = this.db.prepare("SELECT port, pid, session_id, cwd, started_at FROM daemon WHERE id = 1").get() as
			| { port: number; pid: number; session_id: string | null; cwd: string | null; started_at: number | null }
			| undefined;
		if (!row) return undefined;
		return {
			port: row.port,
			pid: row.pid,
			sessionId: row.session_id ?? undefined,
			cwd: row.cwd ?? undefined,
			startedAt: row.started_at ?? undefined,
		};
	}

	clear(): void {
		this.db.prepare("DELETE FROM daemon WHERE id = 1").run();
	}
}
