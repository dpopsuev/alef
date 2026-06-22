import type { Client } from "@libsql/client";

export interface DaemonEntry {
	port: number;
	pid: number;
	sessionId?: string;
	cwd?: string;
	startedAt?: number;
}

export class SqliteDaemonStore {
	private readonly client: Client;

	constructor(client: Client) {
		this.client = client;
	}

	async set(entry: DaemonEntry): Promise<void> {
		await this.client.execute({
			sql: `INSERT INTO daemon (id, port, pid, session_id, cwd, started_at)
				 VALUES (1, ?, ?, ?, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET port = excluded.port, pid = excluded.pid,
				   session_id = excluded.session_id, cwd = excluded.cwd, started_at = excluded.started_at`,
			args: [entry.port, entry.pid, entry.sessionId ?? null, entry.cwd ?? null, entry.startedAt ?? null],
		});
	}

	async get(): Promise<DaemonEntry | undefined> {
		const result = await this.client.execute({
			sql: "SELECT port, pid, session_id, cwd, started_at FROM daemon WHERE id = 1",
			args: [],
		});
		const row = result.rows[0];
		if (!row) return undefined;
		return {
			port: Number(row.port),
			pid: Number(row.pid),
			sessionId: row.session_id != null ? String(row.session_id) : undefined,
			cwd: row.cwd != null ? String(row.cwd) : undefined,
			startedAt: row.started_at != null ? Number(row.started_at) : undefined,
		};
	}

	async clear(): Promise<void> {
		await this.client.execute({
			sql: "DELETE FROM daemon WHERE id = 1",
			args: [],
		});
	}
}
