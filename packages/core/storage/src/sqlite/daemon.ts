import type { Client } from "@libsql/client";
import type { DaemonEntry, DaemonRegistry } from "../interfaces.js";

export type { DaemonEntry };

export class SqliteDaemonRegistry implements DaemonRegistry {
	private readonly client: Client;

	constructor(client: Client) {
		this.client = client;
	}

	async register(entry: DaemonEntry): Promise<void> {
		await this.client.execute({
			sql: `INSERT INTO daemon (port, host, pid, session_id, cwd, started_at, last_heartbeat, token)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(session_id) DO UPDATE SET port = excluded.port, host = excluded.host,
				   pid = excluded.pid, cwd = excluded.cwd, started_at = excluded.started_at,
				   last_heartbeat = excluded.last_heartbeat, token = excluded.token`,
			args: [entry.port, entry.host, entry.pid, entry.sessionId, entry.cwd, entry.startedAt, Date.now(), entry.token ?? null],
		});
	}

	async unregister(sessionId: string): Promise<void> {
		await this.client.execute({
			sql: "DELETE FROM daemon WHERE session_id = ?",
			args: [sessionId],
		});
	}

	async heartbeat(sessionId: string): Promise<void> {
		await this.client.execute({
			sql: "UPDATE daemon SET last_heartbeat = ? WHERE session_id = ?",
			args: [Date.now(), sessionId],
		});
	}

	async get(sessionId: string): Promise<DaemonEntry | undefined> {
		const result = await this.client.execute({
			sql: "SELECT port, host, pid, session_id, cwd, started_at, last_heartbeat, token FROM daemon WHERE session_id = ?",
			args: [sessionId],
		});
		return this.rowToEntry(result.rows[0]);
	}

	async list(): Promise<DaemonEntry[]> {
		const result = await this.client.execute({
			sql: "SELECT port, host, pid, session_id, cwd, started_at, last_heartbeat, token FROM daemon ORDER BY started_at DESC",
			args: [],
		});
		return result.rows.map((row) => this.rowToEntry(row)).filter((e): e is DaemonEntry => e !== undefined);
	}

	async findByCwd(cwd: string): Promise<DaemonEntry | undefined> {
		const result = await this.client.execute({
			sql: "SELECT port, host, pid, session_id, cwd, started_at, last_heartbeat, token FROM daemon WHERE cwd = ? ORDER BY started_at DESC LIMIT 1",
			args: [cwd],
		});
		return this.rowToEntry(result.rows[0]);
	}

	async findLatest(): Promise<DaemonEntry | undefined> {
		const result = await this.client.execute({
			sql: "SELECT port, host, pid, session_id, cwd, started_at, last_heartbeat, token FROM daemon ORDER BY started_at DESC LIMIT 1",
			args: [],
		});
		return this.rowToEntry(result.rows[0]);
	}

	async prune(ttlMs = 180_000): Promise<number> {
		const entries = await this.list();
		const now = Date.now();
		let removed = 0;
		for (const entry of entries) {
			const staleByTtl = entry.lastHeartbeat !== undefined && now - entry.lastHeartbeat > ttlMs;
			if (staleByTtl || !isProcessAlive(entry.pid)) {
				await this.unregister(entry.sessionId);
				removed++;
			}
		}
		return removed;
	}



	private rowToEntry(row: Record<string, unknown> | undefined): DaemonEntry | undefined {
		if (!row) return undefined;
		return {
			port: Number(row.port),
			host: String(row.host ?? "127.0.0.1"),
			pid: Number(row.pid),
			sessionId: String(row.session_id),
			cwd: String(row.cwd ?? ""),
			startedAt: Number(row.started_at ?? 0),
			lastHeartbeat: row.last_heartbeat != null ? Number(row.last_heartbeat) : undefined,
			token: typeof row.token === "string" ? row.token : undefined,
		};
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
