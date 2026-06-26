import { randomUUID } from "node:crypto";
import type { SessionStore, StorageRecord, Turn } from "@dpopsuev/alef-session";
import { TurnIndexer } from "@dpopsuev/alef-session";

const MEMORY_PATH_PREFIX = "memory:";
const SESSION_ID_LENGTH = 8;
const BUS_INTERNAL = "internal";
const EVENT_SESSION_NAME = "session.name";
const CORRELATION_META = "meta";

export class InMemorySessionStore implements SessionStore {
	readonly id: string;
	readonly path: string;

	private readonly _records: StorageRecord[] = [];
	private readonly _indexer = new TurnIndexer();
	private _name: string | undefined;

	constructor(id?: string) {
		this.id = id ?? randomUUID().replace(/-/g, "").slice(0, SESSION_ID_LENGTH);
		this.path = `${MEMORY_PATH_PREFIX}${this.id}`;
	}

	async append(record: StorageRecord): Promise<void> {
		this._records.push(record);
		this._indexer.index(record);
	}

	async events(): Promise<StorageRecord[]> {
		return this._records.slice();
	}

	name(): string | undefined {
		return this._name;
	}

	async setName(name: string): Promise<void> {
		this._name = name;
		await this.append({
			bus: BUS_INTERNAL,
			type: EVENT_SESSION_NAME,
			correlationId: CORRELATION_META,
			payload: { name },
			timestamp: Date.now(),
		});
	}

	async turns(): Promise<Turn[]> {
		return Array.from(this._indexer.turnMap.values());
	}

	async hitCounts(): Promise<Map<string, number>> {
		return new Map(this._indexer.hitCountsMap);
	}

	async adapterHistory(adapterName: string): Promise<StorageRecord[]> {
		const prefix = `${adapterName}.`;
		return this._records.filter((r) => (r.bus === "command" || r.bus === "event") && r.type.startsWith(prefix));
	}
}
