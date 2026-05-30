/**
 * SessionStore — append-only JSONL event log.
 *
 * Storage layout:
 *   ~/.alef/sessions/<cwd-hash>/<session-id>.jsonl
 *   ~/.alef/sessions/<cwd-hash>/latest            — last session ID
 *
 * Each line is a JSON-serialised StorageRecord — a raw Motor or Sense event,
 * or a special window.assembled record written by TurnAssembler.
 *
 * Schema (per ALE-SPC-15):
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
import { appendFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	BusKind,
	SessionStore as ISessionStore,
	StorageRecord,
	Turn,
	WindowAssembledRecord,
} from "@dpopsuev/alef-spine";

// Re-export the types so existing internal imports within runner still work.
export type { BusKind, StorageRecord, Turn, WindowAssembledRecord };
export { hashRecord } from "@dpopsuev/alef-spine";

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

export const EVENT_TYPE_WEIGHTS: Record<string, number> = {
	"fs.write": 2.0,
	"fs.edit": 2.0,
	"lector.write": 2.0,
	"lector.edit": 2.0,
	"shell.exec": 1.5,
	"lector.callers": 1.0,
	"lector.read": 1.0,
	"fs.read": 1.0,
	"web.fetch": 0.9,
	"dialog.message": 0.8,
	"fs.grep": 0.6,
	"fs.find": 0.6,
	"lector.search": 0.6,
	"lector.find": 0.6,
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

export class SessionStore implements ISessionStore {
	readonly id: string;
	readonly path: string;

	private constructor(cwd: string, id: string) {
		this.id = id;
		this.path = sessionPath(cwd, id);
	}

	/** Create a new session. */
	static async create(cwd: string): Promise<SessionStore> {
		const id = randomUUID().replace(/-/g, "").slice(0, 8);
		await ensureDir(cwd);
		await appendFile(sessionPath(cwd, id), "");
		await writeFile(latestPath(cwd), id, "utf-8");
		return new SessionStore(cwd, id);
	}

	/** Resume a session by ID. Throws if not found. */
	static async resume(cwd: string, id: string): Promise<SessionStore> {
		const path = sessionPath(cwd, id);
		try {
			await stat(path);
		} catch {
			throw new Error(`Session '${id}' not found in ${sessionDir(cwd)}`);
		}
		await writeFile(latestPath(cwd), id, "utf-8");
		return new SessionStore(cwd, id);
	}

	/** Resume the most recent session. Returns null if none exists. */
	static async resumeLatest(cwd: string): Promise<SessionStore | null> {
		try {
			const id = (await readFile(latestPath(cwd), "utf-8")).trim();
			return id ? await SessionStore.resume(cwd, id) : null;
		} catch {
			return null;
		}
	}

	/** List all sessions for this cwd, newest first. */
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
	 * Append a raw StorageRecord to the JSONL file. Fire-and-forget safe.
	 * The record must already have its hash field set (computed by SessionLog).
	 */
	async append(record: StorageRecord): Promise<void> {
		await appendFile(this.path, `${JSON.stringify(record)}\n`, "utf-8");
	}

	/** Read all StorageRecords from the JSONL file. */
	async events(): Promise<StorageRecord[]> {
		try {
			const raw = await readFile(this.path, "utf-8");
			return raw
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as StorageRecord);
		} catch {
			return [];
		}
	}

	/**
	 * Group all bus events (not internal records) into Turn[] by correlationId.
	 * Ordered by first-event timestamp ascending (chronological).
	 */
	async turns(): Promise<Turn[]> {
		const records = await this.events();
		const busRecords = records.filter((r) => r.bus === "motor" || r.bus === "sense");

		const turnMap = new Map<string, StorageRecord[]>();
		for (const r of busRecords) {
			let list = turnMap.get(r.correlationId);
			if (!list) {
				list = [];
				turnMap.set(r.correlationId, list);
			}
			list.push(r);
		}

		const turns: Turn[] = [];
		let index = 0;
		for (const [id, events] of turnMap) {
			// Estimate token cost from LLM-relevant content only.
			// totalTokens from usage is the cumulative context size (all turns + system
			// prompt + tools), not the per-turn cost — do not use it as usageAnchor.
			const tokenCost = Math.ceil(events.reduce((n, e) => n + extractContentLength(e.payload), 0) / 4);
			const typeWeight = Math.max(...events.map((e) => eventTypeWeight(e.type)));
			turns.push({ id, events, turnIndex: index++, tokenCost, typeWeight });
		}

		return turns;
	}

	/**
	 * Count how many times each turn was included in a past context window.
	 * Computed by replaying window.assembled records.
	 * Higher hit count → higher LRU frequency score in TurnAssembler.
	 */
	async hitCounts(): Promise<Map<string, number>> {
		const records = await this.events();
		const counts = new Map<string, number>();
		for (const r of records) {
			if (r.bus !== "internal" || r.type !== "window.assembled") continue;
			const ids = (r.payload as WindowAssembledRecord["payload"]).includedTurnIds ?? [];
			for (const id of ids) {
				counts.set(id, (counts.get(id) ?? 0) + 1);
			}
		}
		return counts;
	}
}
