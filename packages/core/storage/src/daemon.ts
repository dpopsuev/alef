import type { Client } from "@libsql/client";
import type { DaemonStore } from "./interfaces.js";

export interface DaemonEntry {
	port: number;
	pid: number;
	sessionId: string;
	cwd: string;
	startedAt: number;
}

export class SqliteDaemonStore implements DaemonStore {
	private readonly client: Client;

	constructor(client: Client) {
		this.client = client;
	}

	async register(entry: DaemonEntry): Promise<void> {
		await this.client.execute({
			sql: `INSERT INTO daemon (port, pid, session_id, cwd, started_at)
				 VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT(session_id) DO UPDATE SET port = excluded.port, pid = excluded.pid,
				   cwd = excluded.cwd, started_at = excluded.started_at`,
			args: [entry.port, entry.pid, entry.sessionId, entry.cwd, entry.startedAt],
		});
	}

	async unregister(sessionId: string): Promise<void> {
		await this.client.execute({
			sql: "DELETE FROM daemon WHERE session_id = ?",
			args: [sessionId],
		});
	}

	async get(sessionId: string): Promise<DaemonEntry | undefined> {
		const result = await this.client.execute({
			sql: "SELECT port, pid, session_id, cwd, started_at FROM daemon WHERE session_id = ?",
			args: [sessionId],
		});
		return this.rowToEntry(result.rows[0]);
	}

	async list(): Promise<DaemonEntry[]> {
		const result = await this.client.execute({
			sql: "SELECT port, pid, session_id, cwd, started_at FROM daemon ORDER BY started_at DESC",
			args: [],
		});
		return result.rows.map((row) => this.rowToEntry(row)).filter((e): e is DaemonEntry => e !== undefined);
	}

	async findByCwd(cwd: string): Promise<DaemonEntry | undefined> {
		const result = await this.client.execute({
			sql: "SELECT port, pid, session_id, cwd, started_at FROM daemon WHERE cwd = ? ORDER BY started_at DESC LIMIT 1",
			args: [cwd],
		});
		return this.rowToEntry(result.rows[0]);
	}

	async findLatest(): Promise<DaemonEntry | undefined> {
		const result = await this.client.execute({
			sql: "SELECT port, pid, session_id, cwd, started_at FROM daemon ORDER BY started_at DESC LIMIT 1",
			args: [],
		});
		return this.rowToEntry(result.rows[0]);
	}

	async prune(): Promise<number> {
		const entries = await this.list();
		let removed = 0;
		for (const entry of entries) {
			if (!isProcessAlive(entry.pid)) {
				await this.unregister(entry.sessionId);
				removed++;
			}
		}
		return removed;
	}

	/** @deprecated Use register/unregister. Single-row compat for migration. */
	async set(entry: DaemonEntry): Promise<void> {
		await this.register(entry);
	}

	/** @deprecated Use findLatest(). Single-row compat for migration. */
	async clear(): Promise<void> {
		await this.client.execute({ sql: "DELETE FROM daemon", args: [] });
	}

	private rowToEntry(row: Record<string, unknown> | undefined): DaemonEntry | undefined {
		if (!row) return undefined;
		return {
			port: Number(row.port),
			pid: Number(row.pid),
			sessionId: String(row.session_id),
			cwd: String(row.cwd ?? ""),
			startedAt: Number(row.started_at ?? 0),
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
