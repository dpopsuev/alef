import { randomUUID } from "node:crypto";
import type { ISessionStore, StorageRecord, Turn } from "@dpopsuev/alef-session";
import { eventTypeWeight, extractContentLength } from "@dpopsuev/alef-session";

/**
 * InMemorySessionStore — implements ISessionStore without touching the filesystem.
 *
 * For use in eval harnesses and tests where memory organ history assembly is
 * needed but disk persistence is not. Replicates the turn-index logic of
 * SessionStore so session context stage behaves identically to production.
 */
export class InMemorySessionStore implements ISessionStore {
	readonly id: string;
	readonly path: string;

	private readonly _cache: StorageRecord[] = [];
	private readonly _turnMap = new Map<string, Turn>();
	private _nextTurnIndex = 0;
	private readonly _turnContentLengths = new Map<string, number>();
	private readonly _hitCountsMap = new Map<string, number>();

	constructor(id = randomUUID().replace(/-/g, "").slice(0, 8)) {
		this.id = id;
		this.path = `/dev/null/memory-session/${this.id}.jsonl`;
	}

	append(record: StorageRecord): Promise<void> {
		this._cache.push(record);
		this._indexRecord(record);
		return Promise.resolve();
	}

	turns(): Promise<Turn[]> {
		return Promise.resolve([...this._turnMap.values()].sort((a, b) => a.turnIndex - b.turnIndex));
	}

	hitCounts(): Promise<Map<string, number>> {
		return Promise.resolve(new Map(this._hitCountsMap));
	}

	organHistory(organName: string): Promise<StorageRecord[]> {
		const prefix = `${organName}.`;
		return Promise.resolve(
			this._cache.filter((r) => (r.bus === "motor" || r.bus === "sense") && r.type.startsWith(prefix)),
		);
	}

	private _indexRecord(record: StorageRecord): void {
		if (record.bus === "internal" && record.type === "window.assembled") {
			const ids = (record.payload as { includedTurnIds?: string[] }).includedTurnIds ?? [];
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
}
