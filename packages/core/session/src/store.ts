/**
 * SessionStore implementation (JSONL), TurnIndexer, and session-scan helpers.
 *
 * SessionStore is the backend-agnostic contract for session persistence.
 * Implementations: JsonlSessionStore (JSONL files), SqliteSessionStore (SQLite),
 * InMemorySessionStore (tests).
 *
 * Session IDs: 8-char hex, typeable, unique per user per cwd.
 */

import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
import type { SessionNameSource, SessionStore, SessionTagsSource, SetNameOptions, SetTagsOptions, StorageRecord, Turn } from "./contracts/storage.js";
import { eventTypeWeight, extractContentLength } from "./context/scoring.js";

const CWD_HASH_LENGTH = 12;
const SESSION_ID_LENGTH = 8;
const CHARS_PER_TOKEN = 4;
const SIZE_CHECK_INTERVAL = 500;
const FILE_SIZE_WARNING_MB = 50;
const BYTES_PER_KB = 1024;
const KB_PER_MB = 1024;
const FILE_SIZE_WARNING_BYTES = FILE_SIZE_WARNING_MB * BYTES_PER_KB * KB_PER_MB;
const DEFAULT_PRUNE_AGE_DAYS = 30;
const DEFAULT_PRUNE_MAX_COUNT = 50;
const HOURS_PER_DAY = 24;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;
const MS_PER_DAY = HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND;
const BUS_INTERNAL = "internal" as const;
const EVENT_SESSION_NAME = "session.name" as const;
const EVENT_SESSION_TAGS = "session.tags" as const;
const EVENT_SESSION_SEARCH_BLOB = "session.search_blob" as const;
const CORRELATION_META = "meta";
const MAX_SESSION_TAGS = 5;

/**
 *
 */
type SessionListMeta = {
	name?: string;
	tags?: string[];
	searchBlob?: string;
};

/**
 * Scan a JSONL session file for the latest name/tags/search_blob meta records.
 */
async function readSessionListMeta(path: string): Promise<SessionListMeta> {
	try {
		const raw = await readFile(path, "utf-8");
		const meta: SessionListMeta = {};
		for (const line of raw.split("\n")) {
			if (!line.includes(`"bus":"${BUS_INTERNAL}"`)) continue;
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- JSONL line to StorageRecord
			const record = JSON.parse(line) as StorageRecord;
			if (record.bus !== BUS_INTERNAL) continue;
			if (record.type === EVENT_SESSION_NAME && typeof record.payload.name === "string") {
				meta.name = record.payload.name;
			} else if (record.type === EVENT_SESSION_TAGS && Array.isArray(record.payload.tags)) {
				meta.tags = record.payload.tags.filter((t): t is string => typeof t === "string");
			} else if (record.type === EVENT_SESSION_SEARCH_BLOB && typeof record.payload.blob === "string") {
				meta.searchBlob = record.payload.blob;
			}
		}
		return meta;
	} catch {
		return {};
	}
}

// ---------------------------------------------------------------------------
// Session-scan helpers (previously session-scan.ts)
// ---------------------------------------------------------------------------

export const SESSION_ROOT = join(homedir(), ".alef", "sessions");

/**
 *
 */
export async function scanSessionFiles(
	visitor: (id: string, path: string, cwdHash: string) => Promise<void>,
): Promise<void> {
	try {
		const cwdHashes = await readdir(SESSION_ROOT);
		for (const cwdHash of cwdHashes) {
			const dir = join(SESSION_ROOT, cwdHash);
			try {
				const entries = await readdir(dir);
				for (const entry of entries) {
					if (!entry.endsWith(".jsonl")) continue;
					const id = entry.replace(".jsonl", "");
					const path = join(dir, entry);
					try {
						await visitor(id, path, cwdHash);
					} catch {
						/* skip unreadable entries */
					}
				}
			} catch {
				/* skip inaccessible directories */
			}
		}
	} catch {
		/* no sessions directory */
	}
}

/**
 *
 */
export function sessionPath(id: string, cwdHash: string): string {
	return join(SESSION_ROOT, cwdHash, `${id}.jsonl`);
}

// ---------------------------------------------------------------------------
// TurnIndexer (previously turn-indexer.ts)
// ---------------------------------------------------------------------------

/**
 *
 */
export function cwdHash(cwd: string): string {
	return createHash("sha1").update(cwd).digest("hex").slice(0, CWD_HASH_LENGTH);
}

/**
 *
 */
function xdgDataHome(): string {
	return process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
}

/** Default multi-plan shelf root: $XDG_DATA_HOME/alef/plans/<cwd-hash>. */
export function plansRootForCwd(cwd: string): string {
	return join(xdgDataHome(), "alef", "plans", cwdHash(cwd));
}

/**
 *
 */
export class TurnIndexer {
	readonly turnMap = new Map<string, Turn>();
	readonly hitCountsMap = new Map<string, number>();
	private _nextTurnIndex = 0;
	private readonly _turnContentLengths = new Map<string, number>();

	index(record: StorageRecord): void {
		if (record.bus === "internal" && record.type === "window.assembled") {
			const ids = (record.payload as { includedTurnIds?: string[] }).includedTurnIds ?? [];
			for (const id of ids) {
				this.hitCountsMap.set(id, (this.hitCountsMap.get(id) ?? 0) + 1);
			}
			return;
		}
		if (record.bus !== "command" && record.bus !== "event" && record.type !== "llm.checkpoint") return;

		const turnId = record.correlationId;
		let turn = this.turnMap.get(turnId);
		if (!turn) {
			turn = { id: turnId, events: [], turnIndex: this._nextTurnIndex++, tokenCost: 0, typeWeight: 0 };
			this.turnMap.set(turnId, turn);
			this._turnContentLengths.set(turnId, 0);
		}
		turn.events.push(record);
		turn.typeWeight = Math.max(turn.typeWeight, eventTypeWeight(record.type));
		const sum = (this._turnContentLengths.get(turnId) ?? 0) + extractContentLength(record.payload);
		this._turnContentLengths.set(turnId, sum);
		turn.tokenCost = Math.ceil(sum / CHARS_PER_TOKEN);
	}

	get nextTurnIndex(): number {
		return this._nextTurnIndex;
	}
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 *
 */
function sessionDir(cwd: string): string {
	return join(homedir(), ".alef", "sessions", cwdHash(cwd));
}

/**
 *
 */
function storeSessionPath(cwd: string, id: string): string {
	return join(sessionDir(cwd), `${id}.jsonl`);
}

/**
 *
 */
function latestPath(cwd: string): string {
	return join(sessionDir(cwd), "latest");
}

/**
 *
 */
async function ensureDir(cwd: string): Promise<void> {
	await mkdir(sessionDir(cwd), { recursive: true });
}

// ---------------------------------------------------------------------------
// JsonlSessionStore
// ---------------------------------------------------------------------------

/**
 *
 */
export class JsonlSessionStore {
	readonly id: string;
	readonly path: string;

	private readonly _cache: StorageRecord[] = [];
	private readonly _indexer = new TurnIndexer();

	private constructor(cwd: string, id: string) {
		this.id = id;
		this.path = storeSessionPath(cwd, id);
	}

	private static async _warmCache(store: JsonlSessionStore): Promise<JsonlSessionStore> {
		try {
			const raw = await readFile(store.path, "utf-8");
			const records = raw
				.split("\n")
				.filter(Boolean)
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- JSONL deserialization to known schema
				.map((line) => JSON.parse(line) as StorageRecord);
			for (const record of records) {
				store._cache.push(record);
				store._indexer.index(record);
			}
		} catch {
			// Empty or missing file — cache stays empty.
		}
		return store;
	}

	static async create(cwd: string): Promise<JsonlSessionStore> {
		const id = randomUUID().replace(/-/g, "").slice(0, SESSION_ID_LENGTH);
		await ensureDir(cwd);
		await appendFile(storeSessionPath(cwd, id), "");
		await writeFile(latestPath(cwd), id, "utf-8");
		return new JsonlSessionStore(cwd, id); // cache starts empty for a new session
	}

	static async resume(cwd: string, id: string): Promise<JsonlSessionStore> {
		const path = storeSessionPath(cwd, id);
		try {
			await stat(path);
		} catch {
			throw new Error(`Session '${id}' not found in ${sessionDir(cwd)}`);
		}
		await writeFile(latestPath(cwd), id, "utf-8");
		return JsonlSessionStore._warmCache(new JsonlSessionStore(cwd, id));
	}

	static async resumeLatest(cwd: string): Promise<JsonlSessionStore | null> {
		try {
			const id = (await readFile(latestPath(cwd), "utf-8")).trim();
			return id ? await JsonlSessionStore.resume(cwd, id) : null;
		} catch {
			return null;
		}
	}

	private _sizeWarned = false;

	async append(record: StorageRecord): Promise<void> {
		this._cache.push(record);
		this._indexer.index(record);
		const line = `${JSON.stringify(record)}\n`;
		await appendFile(this.path, line, "utf-8");

		if (!this._sizeWarned && this._cache.length % SIZE_CHECK_INTERVAL === 0) {
			try {
				const s = await stat(this.path);
				if (s.size > FILE_SIZE_WARNING_BYTES) {
					this._sizeWarned = true;
					process.stderr.write(
						`[session] Warning: session file is ${Math.round(s.size / BYTES_PER_KB / KB_PER_MB)}MB (${this.path}). Consider starting a new session.\n`,
					);
				}
			} catch {}
		}
	}

	events(): Promise<StorageRecord[]> {
		return Promise.resolve(this._cache.slice());
	}

	/** Return the most recently set session name, or undefined if never named. */
	name(): string | undefined {
		for (let i = this._cache.length - 1; i >= 0; i--) {
			const r = this._cache[i]!;
			if (r.bus === BUS_INTERNAL && r.type === EVENT_SESSION_NAME) {
				return typeof r.payload.name === "string" ? r.payload.name : undefined;
			}
		}
		return undefined;
	}

	nameSource(): SessionNameSource | undefined {
		for (let i = this._cache.length - 1; i >= 0; i--) {
			const r = this._cache[i]!;
			if (r.bus === BUS_INTERNAL && r.type === EVENT_SESSION_NAME) {
				const source = r.payload.source;
				if (source === "user" || source === "auto") return source;
				return "user";
			}
		}
		return undefined;
	}

	/** Persist a human-readable name for this session (WAL — last record wins). */
	async setName(name: string, options?: SetNameOptions): Promise<void> {
		const source = options?.source ?? "user";
		if (source === "auto" && this.nameSource() === "user") return;
		await this.append({
			bus: BUS_INTERNAL,
			type: EVENT_SESSION_NAME,
			correlationId: CORRELATION_META,
			payload: { name, source },
			timestamp: Date.now(),
		});
	}

	tags(): readonly string[] {
		for (let i = this._cache.length - 1; i >= 0; i--) {
			const r = this._cache[i]!;
			if (r.bus === BUS_INTERNAL && r.type === EVENT_SESSION_TAGS && Array.isArray(r.payload.tags)) {
				return r.payload.tags.filter((t): t is string => typeof t === "string");
			}
		}
		return [];
	}

	tagsSource(): SessionTagsSource | undefined {
		for (let i = this._cache.length - 1; i >= 0; i--) {
			const r = this._cache[i]!;
			if (r.bus === BUS_INTERNAL && r.type === EVENT_SESSION_TAGS) {
				const source = r.payload.source;
				if (source === "user" || source === "auto") return source;
				return "user";
			}
		}
		return undefined;
	}

	async setTags(tags: readonly string[], options?: SetTagsOptions): Promise<void> {
		const source = options?.source ?? "user";
		if (source === "auto" && this.tagsSource() === "user") return;
		const normalized = [...new Set(tags.map((t) => t.trim().toLowerCase().replace(/\s+/g, "-")).filter(Boolean))].slice(
			0,
			MAX_SESSION_TAGS,
		);
		await this.append({
			bus: BUS_INTERNAL,
			type: EVENT_SESSION_TAGS,
			correlationId: CORRELATION_META,
			payload: { tags: normalized, source },
			timestamp: Date.now(),
		});
	}

	searchBlob(): string | undefined {
		for (let i = this._cache.length - 1; i >= 0; i--) {
			const r = this._cache[i]!;
			if (r.bus === BUS_INTERNAL && r.type === EVENT_SESSION_SEARCH_BLOB) {
				return typeof r.payload.blob === "string" ? r.payload.blob : undefined;
			}
		}
		return undefined;
	}

	async setSearchBlob(blob: string): Promise<void> {
		await this.append({
			bus: BUS_INTERNAL,
			type: EVENT_SESSION_SEARCH_BLOB,
			correlationId: CORRELATION_META,
			payload: { blob },
			timestamp: Date.now(),
		});
	}

	static async prune(cwd: string, maxAgeDays = DEFAULT_PRUNE_AGE_DAYS, maxCount = DEFAULT_PRUNE_MAX_COUNT): Promise<number> {
		const sessions = await JsonlSessionStore.list(cwd);
		const cutoff = Date.now() - maxAgeDays * MS_PER_DAY;
		let removed = 0;
		for (let i = maxCount; i < sessions.length; i++) {
			if (sessions[i]!.mtime.getTime() < cutoff) {
				try {
					await unlink(sessions[i]!.path);
					const summaryPath = sessions[i]!.path.replace(".jsonl", ".summary.json");
					await unlink(summaryPath).catch(() => {});
					removed++;
				} catch {}
			}
		}
		return removed;
	}

	static async list(
		cwd: string,
	): Promise<Array<{ id: string; path: string; mtime: Date; name?: string; tags?: string[]; searchBlob?: string }>> {
		try {
			const dir = sessionDir(cwd);
			const entries = await readdir(dir);
			const sessions = await Promise.all(
				entries
					.filter((e) => e.endsWith(".jsonl"))
					.map(async (e) => {
						const id = e.replace(".jsonl", "");
						const p = join(dir, e);
						const s = await stat(p);
						const meta = await readSessionListMeta(p);
						return { id, path: p, mtime: s.mtime, ...meta };
					}),
			);
			return sessions.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
		} catch {
			return [];
		}
	}

	static async listAll(): Promise<
		Array<{ id: string; path: string; mtime: Date; cwd?: string; name?: string; tags?: string[]; searchBlob?: string }>
	> {
		const results: Array<{
			id: string;
			path: string;
			mtime: Date;
			cwd?: string;
			name?: string;
			tags?: string[];
			searchBlob?: string;
		}> = [];
		await scanSessionFiles(async (id, path) => {
			try {
				const s = await stat(path);
				const meta = await readSessionListMeta(path);
				results.push({ id, path, mtime: s.mtime, ...meta });
			} catch {
				/* skip */
			}
		});
		return results.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
	}

	/**
	 * Group all bus events into Turn[] by correlationId, ordered chronologically.
	 * Reads from the incremental index built in append() — O(n_turns) not O(n_events).
	 */
	turns(): Promise<Turn[]> {
		return Promise.resolve(Array.from(this._indexer.turnMap.values()));
	}

	/**
	 * Count how many times each turn was included in a past context window.
	 * Reads from the incremental index built in append() — O(1).
	 */
	hitCounts(): Promise<Map<string, number>> {
		return Promise.resolve(new Map(this._indexer.hitCountsMap));
	}

	/**
	 * Return all command and event events whose type starts with `<adapterName>.`.
	 * O(n_events) scan — intended for diagnostics and session context stage context injection.
	 */
	adapterHistory(adapterName: string): Promise<StorageRecord[]> {
		const prefix = `${adapterName}.`;
		return Promise.resolve(
			this._cache.filter((r) => (r.bus === "command" || r.bus === "event") && r.type.startsWith(prefix)),
		);
	}
}
