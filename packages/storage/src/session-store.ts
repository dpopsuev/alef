import { randomUUID } from "node:crypto";
import { cwdHash, type SessionStore, type StorageRecord, type Turn, TurnIndexer } from "@dpopsuev/alef-session";
import type { Client } from "@libsql/client";
import { queueEmbedding } from "./embedder.js";

function deriveOrgan(type: string): string | null {
	const dot = type.indexOf(".");
	return dot > 0 ? type.slice(0, dot) : null;
}

export class SqliteSessionStore implements SessionStore {
	readonly id: string;
	readonly path: string;

	private readonly _client: Client;

	private readonly _cache: StorageRecord[] = [];
	private readonly _indexer = new TurnIndexer();

	private readonly _version: string;

	private constructor(client: Client, id: string, version?: string) {
		this._client = client;
		this.id = id;
		this.path = `sqlite:alef.db#${id}`;
		this._version = version ?? process.env.npm_package_version ?? "unknown";
	}

	private async _warmFromDb(): Promise<void> {
		const result = await this._client.execute({
			sql: `SELECT bus, type, correlation_id, payload, timestamp, elapsed, hash,
					actor_address, actor_type, session_id
			 FROM events WHERE session_id = ? ORDER BY rowid`,
			args: [this.id],
		});

		for (const row of result.rows) {
			const record: StorageRecord = {
				bus: String(row.bus) as StorageRecord["bus"],
				type: String(row.type),
				correlationId: String(row.correlation_id),
				payload: JSON.parse(String(row.payload)) as Record<string, unknown>,
				timestamp: Number(row.timestamp),
				elapsed: row.elapsed != null ? Number(row.elapsed) : undefined,
				hash: row.hash != null ? String(row.hash) : undefined,
				sessionId: row.session_id != null ? String(row.session_id) : undefined,
				actor:
					row.actor_address != null && row.actor_type != null
						? { address: String(row.actor_address), type: String(row.actor_type) as "human" | "agent" }
						: undefined,
			};
			this._cache.push(record);
			this._indexer.index(record);
		}
	}

	static async create(client: Client, cwd: string, version?: string): Promise<SqliteSessionStore> {
		const id = randomUUID().replace(/-/g, "").slice(0, 8);
		const hash = cwdHash(cwd);
		const now = Date.now();
		await client.execute({
			sql: "INSERT INTO sessions (id, cwd_hash, cwd, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?)",
			args: [id, hash, cwd, now, now, version ?? process.env.npm_package_version ?? "unknown"],
		});
		return new SqliteSessionStore(client, id, version);
	}

	static async resume(client: Client, cwd: string, id: string, version?: string): Promise<SqliteSessionStore> {
		const hash = cwdHash(cwd);
		const result = await client.execute({
			sql: "SELECT id FROM sessions WHERE id = ? AND cwd_hash = ?",
			args: [id, hash],
		});
		if (result.rows.length === 0) throw new Error(`Session '${id}' not found for cwd hash ${hash}`);
		const store = new SqliteSessionStore(client, id, version);
		await store._warmFromDb();
		return store;
	}

	static async resumeLatest(client: Client, cwd: string, version?: string): Promise<SqliteSessionStore | null> {
		const hash = cwdHash(cwd);
		const result = await client.execute({
			sql: "SELECT id FROM sessions WHERE cwd_hash = ? ORDER BY updated_at DESC LIMIT 1",
			args: [hash],
		});
		if (result.rows.length === 0) return null;
		return SqliteSessionStore.resume(client, cwd, String(result.rows[0].id), version);
	}

	static async list(client: Client, cwd: string): Promise<Array<{ id: string; path: string; mtime: Date }>> {
		const hash = cwdHash(cwd);
		const result = await client.execute({
			sql: "SELECT id, updated_at FROM sessions WHERE cwd_hash = ? ORDER BY updated_at DESC",
			args: [hash],
		});
		return result.rows.map((r) => ({
			id: String(r.id),
			path: `sqlite:alef.db#${String(r.id)}`,
			mtime: new Date(Number(r.updated_at)),
		}));
	}

	static async prune(client: Client, cwd: string, maxAgeDays = 30, maxCount = 50): Promise<number> {
		const hash = cwdHash(cwd);
		const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
		const result = await client.execute({
			sql: "SELECT id, updated_at FROM sessions WHERE cwd_hash = ? ORDER BY updated_at DESC",
			args: [hash],
		});

		let removed = 0;
		for (let i = maxCount; i < result.rows.length; i++) {
			const updatedAt = Number(result.rows[i].updated_at);
			if (updatedAt < cutoff) {
				const sid = String(result.rows[i].id);
				await client.batch(
					[
						{ sql: "DELETE FROM events WHERE session_id = ?", args: [sid] },
						{ sql: "DELETE FROM session_summaries WHERE session_id = ?", args: [sid] },
						{ sql: "DELETE FROM sessions WHERE id = ?", args: [sid] },
					],
					"write",
				);
				removed++;
			}
		}
		return removed;
	}

	async append(record: StorageRecord): Promise<void> {
		this._cache.push(record);
		this._indexer.index(record);

		const adapter = deriveOrgan(record.type);
		const turnNumber = this._indexer.turnMap.has(record.correlationId)
			? this._indexer.turnMap.get(record.correlationId)!.turnIndex
			: null;

		const insertResult = await this._client.execute({
			sql: `INSERT INTO events (session_id, bus, type, correlation_id, payload,
				timestamp, elapsed, hash, actor_address, actor_type, organ, turn_number, version)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			args: [
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
				adapter,
				turnNumber,
				this._version,
			],
		});
		await this._client.execute({
			sql: "UPDATE sessions SET updated_at = ? WHERE id = ?",
			args: [Date.now(), this.id],
		});

		queueEmbedding(this._client, Number(insertResult.lastInsertRowid), record.bus, record.type, record.payload);
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
		await this._client.execute({ sql: "UPDATE sessions SET name = ? WHERE id = ?", args: [name, this.id] });
	}

	turns(): Promise<Turn[]> {
		return Promise.resolve(Array.from(this._indexer.turnMap.values()));
	}

	hitCounts(): Promise<Map<string, number>> {
		return Promise.resolve(new Map(this._indexer.hitCountsMap));
	}

	organHistory(adapterName: string): Promise<StorageRecord[]> {
		const prefix = `${adapterName}.`;
		return Promise.resolve(
			this._cache.filter((r) => (r.bus === "command" || r.bus === "event") && r.type.startsWith(prefix)),
		);
	}
}
