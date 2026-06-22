import { randomUUID } from "node:crypto";
import { cwdHash, type SessionStore, type StorageRecord, type Turn, TurnIndexer } from "@dpopsuev/alef-session";
import type Database from "better-sqlite3";

function deriveOrgan(type: string): string | null {
	const dot = type.indexOf(".");
	return dot > 0 ? type.slice(0, dot) : null;
}

export class SqliteSessionStore implements SessionStore {
	readonly id: string;
	readonly path: string;

	private readonly _db: Database.Database;

	private readonly _cache: StorageRecord[] = [];
	private readonly _indexer = new TurnIndexer();

	private readonly _version: string;

	private readonly _insertEvent: Database.Statement;
	private readonly _updateSession: Database.Statement;

	private constructor(db: Database.Database, id: string, version?: string) {
		this._db = db;
		this.id = id;
		this.path = `sqlite:alef.db#${id}`;
		this._version = version ?? process.env.npm_package_version ?? "unknown";

		this._insertEvent = db.prepare(`
			INSERT INTO events (session_id, bus, type, correlation_id, payload,
				timestamp, elapsed, hash, actor_address, actor_type, organ, turn_number, version)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		this._updateSession = db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?");
	}

	private _warmFromDb(): void {
		const rows = this._db
			.prepare(
				`SELECT bus, type, correlation_id, payload, timestamp, elapsed, hash,
						actor_address, actor_type, session_id
				 FROM events WHERE session_id = ? ORDER BY rowid`,
			)
			.all(this.id) as Array<{
			bus: string;
			type: string;
			correlation_id: string;
			payload: string;
			timestamp: number;
			elapsed: number | null;
			hash: string | null;
			actor_address: string | null;
			actor_type: string | null;
			session_id: string | null;
		}>;

		for (const row of rows) {
			const record: StorageRecord = {
				bus: row.bus as StorageRecord["bus"],
				type: row.type,
				correlationId: row.correlation_id,
				payload: JSON.parse(row.payload) as Record<string, unknown>,
				timestamp: row.timestamp,
				elapsed: row.elapsed ?? undefined,
				hash: row.hash ?? undefined,
				sessionId: row.session_id ?? undefined,
				actor:
					row.actor_address && row.actor_type
						? { address: row.actor_address, type: row.actor_type as "human" | "agent" }
						: undefined,
			};
			this._cache.push(record);
			this._indexer.index(record);
		}
	}

	static create(db: Database.Database, cwd: string, version?: string): SqliteSessionStore {
		const id = randomUUID().replace(/-/g, "").slice(0, 8);
		const hash = cwdHash(cwd);
		const now = Date.now();
		db.prepare(
			"INSERT INTO sessions (id, cwd_hash, cwd, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?)",
		).run(id, hash, cwd, now, now, version ?? process.env.npm_package_version ?? "unknown");
		return new SqliteSessionStore(db, id, version);
	}

	static resume(db: Database.Database, cwd: string, id: string, version?: string): SqliteSessionStore {
		const hash = cwdHash(cwd);
		const row = db.prepare("SELECT id FROM sessions WHERE id = ? AND cwd_hash = ?").get(id, hash) as
			| { id: string }
			| undefined;
		if (!row) throw new Error(`Session '${id}' not found for cwd hash ${hash}`);
		const store = new SqliteSessionStore(db, id, version);
		store._warmFromDb();
		return store;
	}

	static resumeLatest(db: Database.Database, cwd: string, version?: string): SqliteSessionStore | null {
		const hash = cwdHash(cwd);
		const row = db.prepare("SELECT id FROM sessions WHERE cwd_hash = ? ORDER BY updated_at DESC LIMIT 1").get(hash) as
			| { id: string }
			| undefined;
		if (!row) return null;
		return SqliteSessionStore.resume(db, cwd, row.id, version);
	}

	static list(db: Database.Database, cwd: string): Array<{ id: string; path: string; mtime: Date }> {
		const hash = cwdHash(cwd);
		const rows = db
			.prepare("SELECT id, updated_at FROM sessions WHERE cwd_hash = ? ORDER BY updated_at DESC")
			.all(hash) as Array<{ id: string; updated_at: number }>;
		return rows.map((r) => ({
			id: r.id,
			path: `sqlite:alef.db#${r.id}`,
			mtime: new Date(r.updated_at),
		}));
	}

	static prune(db: Database.Database, cwd: string, maxAgeDays = 30, maxCount = 50): number {
		const hash = cwdHash(cwd);
		const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
		const rows = db
			.prepare("SELECT id FROM sessions WHERE cwd_hash = ? ORDER BY updated_at DESC")
			.all(hash) as Array<{ id: string }>;

		let removed = 0;
		const deleteEvents = db.prepare("DELETE FROM events WHERE session_id = ?");
		const deleteSummary = db.prepare("DELETE FROM session_summaries WHERE session_id = ?");
		const deleteSession = db.prepare("DELETE FROM sessions WHERE id = ?");

		for (let i = maxCount; i < rows.length; i++) {
			const sessionRow = db.prepare("SELECT updated_at FROM sessions WHERE id = ?").get(rows[i].id) as
				| { updated_at: number }
				| undefined;
			if (sessionRow && sessionRow.updated_at < cutoff) {
				deleteEvents.run(rows[i].id);
				deleteSummary.run(rows[i].id);
				deleteSession.run(rows[i].id);
				removed++;
			}
		}
		return removed;
	}

	async append(record: StorageRecord): Promise<void> {
		this._cache.push(record);
		this._indexer.index(record);

		const organ = deriveOrgan(record.type);
		const turnNumber = this._indexer.turnMap.has(record.correlationId)
			? this._indexer.turnMap.get(record.correlationId)!.turnIndex
			: null;

		this._insertEvent.run(
			this.id,
			record.bus,
			record.type,
			record.correlationId,
			JSON.stringify(record.payload),
			record.timestamp,
			record.elapsed ?? null,
			record.hash ?? null,
			record.actor?.address ?? null,
			record.actor?.type ?? null,
			organ,
			turnNumber,
			this._version,
		);
		this._updateSession.run(Date.now(), this.id);
	}

	events(): Promise<StorageRecord[]> {
		return Promise.resolve(this._cache.slice());
	}

	name(): string | undefined {
		for (let i = this._cache.length - 1; i >= 0; i--) {
			const r = this._cache[i];
			if (r.bus === "internal" && r.type === "session.name") {
				return typeof r.payload.name === "string" ? r.payload.name : undefined;
			}
		}
		return undefined;
	}

	async setName(name: string): Promise<void> {
		await this.append({
			bus: "internal",
			type: "session.name",
			correlationId: "meta",
			payload: { name },
			timestamp: Date.now(),
		});
		this._db.prepare("UPDATE sessions SET name = ? WHERE id = ?").run(name, this.id);
	}

	turns(): Promise<Turn[]> {
		return Promise.resolve(Array.from(this._indexer.turnMap.values()));
	}

	hitCounts(): Promise<Map<string, number>> {
		return Promise.resolve(new Map(this._indexer.hitCountsMap));
	}

	organHistory(organName: string): Promise<StorageRecord[]> {
		const prefix = `${organName}.`;
		return Promise.resolve(
			this._cache.filter((r) => (r.bus === "motor" || r.bus === "sense") && r.type.startsWith(prefix)),
		);
	}
}
