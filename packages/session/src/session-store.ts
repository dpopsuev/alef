/**
 * JsonlSessionStore — append-only JSONL event log.
 *
 * Storage layout:
 *   ~/.alef/sessions/<cwd-hash>/<session-id>.jsonl
 *   ~/.alef/sessions/<cwd-hash>/latest            — last session ID
 *
 * Each line is a JSON-serialised StorageRecord — a raw Motor or Sense event,
 * or a special window.assembled record written by TurnAssembler.
 *
 * Schema:
 *   { bus: 'motor'|'sense'|'internal', type, correlationId, payload, timestamp }
 *
 * Projections are NEVER stored — they are computed from the log on read:
 *   events()    → all StorageRecords
 *   turns()     → grouped by correlationId into Turn[]
 *   hitCounts() → counts window.assembled inclusions per turnId
 *
 * Session IDs: 8-char hex, typeable, unique per user per cwd.
 */

import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Storage record types — moved from @dpopsuev/alef-kernel (CRP: only runner uses these)
// ---------------------------------------------------------------------------

export type BusKind = "motor" | "sense" | "signal" | "internal";

/** Actor identity stamped on each StorageRecord by SessionLog. */
export interface StorageActor {
	/** "@crimson" or "@dpopsuev" — the @ address of who produced this event. */
	address: string;
	type: "human" | "agent";
}

export interface StorageRecord {
	bus: BusKind;
	type: string;
	correlationId: string;
	payload: Record<string, unknown>;
	timestamp: number;
	elapsed?: number;
	hash?: string;
	/** The conversation ID (JsonlSessionStore.id) — the Topic this event belongs to. */
	sessionId?: string;
	/** Who produced this event. */
	actor?: StorageActor;
}

export function hashRecord(record: Omit<StorageRecord, "hash">): string {
	const stable = JSON.stringify({
		bus: record.bus,
		type: record.type,
		correlationId: record.correlationId,
		payload: record.payload,
		timestamp: record.timestamp,
	});
	return createHash("sha256").update(stable, "utf-8").digest("hex");
}

export interface WindowAssembledRecord extends StorageRecord {
	bus: Extract<BusKind, "internal">;
	type: "window.assembled";
	payload: {
		includedTurnIds: string[];
		queryTokens: string[];
		budgetUsed: number;
		budgetTotal: number;
	};
}

export interface Turn {
	id: string;
	events: StorageRecord[];
	turnIndex: number;
	tokenCost: number;
	typeWeight: number;
}

export interface SessionStore {
	readonly id: string;
	readonly path: string;
	append(record: StorageRecord): Promise<void>;
	events(): Promise<StorageRecord[]>;
	turns(): Promise<Turn[]>;
	hitCounts(): Promise<Map<string, number>>;
	organHistory(organName: string): Promise<StorageRecord[]>;
}

// ---------------------------------------------------------------------------

export const EVENT_TYPE_WEIGHTS: Record<string, number> = {
	"fs.write": 2.0,
	"fs.edit": 2.0,
	"code.write": 2.0,
	"code.edit": 2.0,
	"shell.exec": 1.5,
	"code.callers": 1.0,
	"code.read": 1.0,
	"fs.read": 1.0,
	"web.fetch": 0.9,
	"llm.response": 0.8,
	"fs.grep": 0.6,
	"fs.find": 0.6,
	"code.search": 0.6,
	"code.find": 0.6,
};

export function eventTypeWeight(type: string): number {
	return EVENT_TYPE_WEIGHTS[type] ?? 0.5;
}

/**
 * Extract the LLM-relevant content length from an event payload.
 *
 * Priority: _display.text (human-facing, already clean) → content → text →
 * output → JSON.stringify remainder. Skips metadata fields (toolCallId,
 * correlationId, usage, isFinal) that inflate JSON.stringify estimates
 * without contributing to actual LLM token counts.
 */
export function extractContentLength(payload: Record<string, unknown>): number {
	const display = (payload._display as { text?: string } | undefined)?.text;
	if (typeof display === "string") return display.length;
	if (typeof payload.content === "string") return payload.content.length;
	if (typeof payload.text === "string") return payload.text.length;
	if (typeof payload.output === "string") return payload.output.length;
	// Fallback: JSON of payload minus known metadata keys.
	const { _display: _d, toolCallId: _t, isFinal: _f, usage: _u, ...rest } = payload;
	return JSON.stringify(rest).length;
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

function cwdHash(cwd: string): string {
	return createHash("sha1").update(cwd).digest("hex").slice(0, 12);
}

function sessionDir(cwd: string): string {
	return join(homedir(), ".alef", "sessions", cwdHash(cwd));
}

function sessionPath(cwd: string, id: string): string {
	return join(sessionDir(cwd), `${id}.jsonl`);
}

function latestPath(cwd: string): string {
	return join(sessionDir(cwd), "latest");
}

async function ensureDir(cwd: string): Promise<void> {
	await mkdir(sessionDir(cwd), { recursive: true });
}

export class JsonlSessionStore {
	readonly id: string;
	readonly path: string;

	// Raw event log — append-only, used by events() and to warm turn index.
	private readonly _cache: StorageRecord[] = [];

	// Incremental turn index — updated on every append() so turns() and
	// hitCounts() are O(1) reads rather than full-log scans.
	private readonly _turnMap: Map<string, Turn> = new Map();
	private _nextTurnIndex = 0;
	private readonly _turnContentLengths: Map<string, number> = new Map();
	private readonly _hitCountsMap: Map<string, number> = new Map();

	private constructor(cwd: string, id: string) {
		this.id = id;
		this.path = sessionPath(cwd, id);
	}

	private _indexRecord(record: StorageRecord): void {
		if (record.bus === "internal" && record.type === "window.assembled") {
			const ids = (record.payload as WindowAssembledRecord["payload"]).includedTurnIds ?? [];
			for (const id of ids) {
				this._hitCountsMap.set(id, (this._hitCountsMap.get(id) ?? 0) + 1);
			}
			return;
		}
		if (record.bus !== "motor" && record.bus !== "sense" && record.type !== "llm.checkpoint") return;

		const turnId = record.correlationId;
		let turn = this._turnMap.get(turnId);
		if (!turn) {
			turn = { id: turnId, events: [], turnIndex: this._nextTurnIndex++, tokenCost: 0, typeWeight: 0 };
			this._turnMap.set(turnId, turn);
			this._turnContentLengths.set(turnId, 0);
		}
		turn.events.push(record);
		turn.typeWeight = Math.max(turn.typeWeight, eventTypeWeight(record.type));
		const sum = (this._turnContentLengths.get(turnId) ?? 0) + extractContentLength(record.payload);
		this._turnContentLengths.set(turnId, sum);
		turn.tokenCost = Math.ceil(sum / 4);
	}

	private static async _warmCache(store: JsonlSessionStore): Promise<JsonlSessionStore> {
		try {
			const raw = await readFile(store.path, "utf-8");
			const records = raw
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as StorageRecord);
			for (const record of records) {
				store._cache.push(record);
				store._indexRecord(record);
			}
		} catch {
			// Empty or missing file — cache stays empty.
		}
		return store;
	}

	static async create(cwd: string): Promise<JsonlSessionStore> {
		const id = randomUUID().replace(/-/g, "").slice(0, 8);
		await ensureDir(cwd);
		await appendFile(sessionPath(cwd, id), "");
		await writeFile(latestPath(cwd), id, "utf-8");
		return new JsonlSessionStore(cwd, id); // cache starts empty for a new session
	}

	static async resume(cwd: string, id: string): Promise<JsonlSessionStore> {
		const path = sessionPath(cwd, id);
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
		this._indexRecord(record);
		const line = `${JSON.stringify(record)}\n`;
		await appendFile(this.path, line, "utf-8");

		if (!this._sizeWarned && this._cache.length % 500 === 0) {
			try {
				const s = await stat(this.path);
				if (s.size > 50 * 1024 * 1024) {
					this._sizeWarned = true;
					process.stderr.write(
						`[session] Warning: session file is ${Math.round(s.size / 1024 / 1024)}MB (${this.path}). Consider starting a new session.\n`,
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
			const r = this._cache[i];
			if (r.bus === "internal" && r.type === "session.name") {
				return typeof r.payload.name === "string" ? r.payload.name : undefined;
			}
		}
		return undefined;
	}

	/** Persist a human-readable name for this session (WAL — last record wins). */
	async setName(name: string): Promise<void> {
		await this.append({
			bus: "internal",
			type: "session.name",
			correlationId: "meta",
			payload: { name },
			timestamp: Date.now(),
		});
	}

	static async prune(cwd: string, maxAgeDays = 30, maxCount = 50): Promise<number> {
		const sessions = await JsonlSessionStore.list(cwd);
		const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
		let removed = 0;
		for (let i = maxCount; i < sessions.length; i++) {
			if (sessions[i].mtime.getTime() < cutoff) {
				try {
					await unlink(sessions[i].path);
					const summaryPath = sessions[i].path.replace(".jsonl", ".summary.json");
					await unlink(summaryPath).catch(() => {});
					removed++;
				} catch {}
			}
		}
		return removed;
	}

	static async list(cwd: string): Promise<Array<{ id: string; path: string; mtime: Date }>> {
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
						return { id, path: p, mtime: s.mtime };
					}),
			);
			return sessions.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
		} catch {
			return [];
		}
	}

	/**
	 * Group all bus events into Turn[] by correlationId, ordered chronologically.
	 * Reads from the incremental index built in append() — O(n_turns) not O(n_events).
	 */
	turns(): Promise<Turn[]> {
		return Promise.resolve(Array.from(this._turnMap.values()));
	}

	/**
	 * Count how many times each turn was included in a past context window.
	 * Reads from the incremental index built in append() — O(1).
	 */
	hitCounts(): Promise<Map<string, number>> {
		return Promise.resolve(new Map(this._hitCountsMap));
	}

	/**
	 * Return all motor and sense events whose type starts with `<organName>.`.
	 * O(n_events) scan — intended for diagnostics and session context stage context injection.
	 */
	organHistory(organName: string): Promise<StorageRecord[]> {
		const prefix = `${organName}.`;
		return Promise.resolve(
			this._cache.filter((r) => (r.bus === "motor" || r.bus === "sense") && r.type.startsWith(prefix)),
		);
	}
}

/** @deprecated Use SessionStore (the interface) */
export type ISessionStore = SessionStore;
