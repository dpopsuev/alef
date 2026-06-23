import { randomUUID } from "node:crypto";
import type { SessionStore, StorageRecord, Turn } from "@dpopsuev/alef-session";
import { TurnIndexer } from "@dpopsuev/alef-session";

export class InMemorySessionStore implements SessionStore {
	readonly id: string;
	readonly path: string;

	private readonly _cache: StorageRecord[] = [];
	private readonly _indexer = new TurnIndexer();

	constructor(id = randomUUID().replace(/-/g, "").slice(0, 8)) {
		this.id = id;
		this.path = `/dev/null/memory-session/${this.id}.jsonl`;
	}

	append(record: StorageRecord): Promise<void> {
		this._cache.push(record);
		this._indexer.index(record);
		return Promise.resolve();
	}

	events(): Promise<StorageRecord[]> {
		return Promise.resolve(this._cache.slice());
	}

	turns(): Promise<Turn[]> {
		return Promise.resolve([...this._indexer.turnMap.values()].sort((a, b) => a.turnIndex - b.turnIndex));
	}

	hitCounts(): Promise<Map<string, number>> {
		return Promise.resolve(new Map(this._indexer.hitCountsMap));
	}

	organHistory(organName: string): Promise<StorageRecord[]> {
		const prefix = `${organName}.`;
		return Promise.resolve(
			this._cache.filter((r) => (r.bus === "command" || r.bus === "event") && r.type.startsWith(prefix)),
		);
	}

	private _name: string | undefined;

	name(): string | undefined {
		return this._name;
	}

	async setName(n: string): Promise<void> {
		this._name = n;
	}
}
