import { randomUUID } from "node:crypto";
import type {
	SessionNameSource,
	SessionStore,
	SessionTagsSource,
	SetNameOptions,
	SetTagsOptions,
	StorageRecord,
	Turn,
} from "@dpopsuev/alef-session/storage";
import { TurnIndexer } from "@dpopsuev/alef-session/store";

const MEMORY_PATH_PREFIX = "memory:";
const SESSION_ID_LENGTH = 8;
const BUS_INTERNAL = "internal";
const EVENT_SESSION_NAME = "session.name";
const EVENT_SESSION_TAGS = "session.tags";
const EVENT_SESSION_SEARCH_BLOB = "session.search_blob";
const CORRELATION_META = "meta";
const MAX_TAGS = 5;

/**
 *
 */
function normalizeTags(tags: readonly string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of tags) {
		const tag = raw.trim().toLowerCase().replace(/\s+/g, "-");
		if (!tag || seen.has(tag)) continue;
		seen.add(tag);
		out.push(tag);
		if (out.length >= MAX_TAGS) break;
	}
	return out;
}

/**
 *
 */
export class InMemorySessionStore implements SessionStore {
	readonly id: string;
	readonly path: string;

	private readonly _records: StorageRecord[] = [];
	private readonly _indexer = new TurnIndexer();
	private _name: string | undefined;
	private _nameSource: SessionNameSource | undefined;
	private _tags: string[] = [];
	private _tagsSource: SessionTagsSource | undefined;
	private _searchBlob: string | undefined;

	constructor(id?: string) {
		this.id = id ?? randomUUID().replace(/-/g, "").slice(0, SESSION_ID_LENGTH);
		this.path = `${MEMORY_PATH_PREFIX}${this.id}`;
	}

	// eslint-disable-next-line @typescript-eslint/require-await
	async append(record: StorageRecord): Promise<void> {
		this._records.push(record);
		this._indexer.index(record);
	}

	// eslint-disable-next-line @typescript-eslint/require-await
	async events(): Promise<StorageRecord[]> {
		return this._records.slice();
	}

	name(): string | undefined {
		return this._name;
	}

	nameSource(): SessionNameSource | undefined {
		return this._nameSource;
	}

	async setName(name: string, options?: SetNameOptions): Promise<void> {
		const source = options?.source ?? "user";
		if (source === "auto" && this._nameSource === "user") return;
		this._name = name;
		this._nameSource = source;
		await this.append({
			bus: BUS_INTERNAL,
			type: EVENT_SESSION_NAME,
			correlationId: CORRELATION_META,
			payload: { name, source },
			timestamp: Date.now(),
		});
	}

	tags(): readonly string[] {
		return this._tags;
	}

	tagsSource(): SessionTagsSource | undefined {
		return this._tagsSource;
	}

	async setTags(tags: readonly string[], options?: SetTagsOptions): Promise<void> {
		const source = options?.source ?? "user";
		if (source === "auto" && this._tagsSource === "user") return;
		this._tags = normalizeTags(tags);
		this._tagsSource = source;
		await this.append({
			bus: BUS_INTERNAL,
			type: EVENT_SESSION_TAGS,
			correlationId: CORRELATION_META,
			payload: { tags: this._tags, source },
			timestamp: Date.now(),
		});
	}

	searchBlob(): string | undefined {
		return this._searchBlob;
	}

	async setSearchBlob(blob: string): Promise<void> {
		this._searchBlob = blob;
		await this.append({
			bus: BUS_INTERNAL,
			type: EVENT_SESSION_SEARCH_BLOB,
			correlationId: CORRELATION_META,
			payload: { blob },
			timestamp: Date.now(),
		});
	}

	// eslint-disable-next-line @typescript-eslint/require-await
	async turns(): Promise<Turn[]> {
		return Array.from(this._indexer.turnMap.values());
	}

	// eslint-disable-next-line @typescript-eslint/require-await
	async hitCounts(): Promise<Map<string, number>> {
		return new Map(this._indexer.hitCountsMap);
	}

	// eslint-disable-next-line @typescript-eslint/require-await
	async adapterHistory(adapterName: string): Promise<StorageRecord[]> {
		const prefix = `${adapterName}.`;
		return this._records.filter((r) => (r.bus === "command" || r.bus === "event") && r.type.startsWith(prefix));
	}

	// eslint-disable-next-line @typescript-eslint/require-await
	async isEmpty(): Promise<boolean> {
		if (this._name) return false;
		return !this._records.some((r) => r.type === "llm.input");
	}

	// eslint-disable-next-line @typescript-eslint/require-await
	async destroy(): Promise<void> {
		this._records.length = 0;
		this._indexer.turnMap.clear();
		this._indexer.hitCountsMap.clear();
		this._name = undefined;
		this._nameSource = undefined;
		this._tags = [];
		this._tagsSource = undefined;
		this._searchBlob = undefined;
	}
}
