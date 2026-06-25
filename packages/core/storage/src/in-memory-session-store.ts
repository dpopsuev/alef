import { randomUUID } from "node:crypto";
import type { SessionStore, StorageRecord, Turn } from "@dpopsuev/alef-session";
import { TurnIndexer } from "@dpopsuev/alef-session";

export class InMemorySessionStore implements SessionStore {
	readonly id: string;
	readonly path: string;

	private readonly _records: StorageRecord[] = [];
	private readonly _indexer = new TurnIndexer();
	private _name: string | undefined;

	constructor(id?: string) {
		this.id = id ?? randomUUID().replace(/-/g, "").slice(0, 8);
		this.path = `memory:${this.id}`;
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
			bus: "internal",
			type: "session.name",
			correlationId: "meta",
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
