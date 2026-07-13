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

	private readonly _cache: StorageRecord[] = [];
	private readonly _indexer = new TurnIndexer();

	// eslint-disable-next-line no-magic-numbers
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

	adapterHistory(adapterName: string): Promise<StorageRecord[]> {
		const prefix = `${adapterName}.`;
		return Promise.resolve(
			this._cache.filter((r) => (r.bus === "command" || r.bus === "event") && r.type.startsWith(prefix)),
		);
	}

	private _name: string | undefined;
	private _nameSource: SessionNameSource | undefined;
	private _tags: string[] = [];
	private _tagsSource: SessionTagsSource | undefined;
	private _searchBlob: string | undefined;

	name(): string | undefined {
		return this._name;
	}

	nameSource(): SessionNameSource | undefined {
		return this._nameSource;
	}

	// eslint-disable-next-line @typescript-eslint/require-await
	async setName(n: string, options?: SetNameOptions): Promise<void> {
		const source = options?.source ?? "user";
		if (source === "auto" && this._nameSource === "user") return;
		this._name = n;
		this._nameSource = source;
	}

	tags(): readonly string[] {
		return this._tags;
	}

	tagsSource(): SessionTagsSource | undefined {
		return this._tagsSource;
	}

	// eslint-disable-next-line @typescript-eslint/require-await
	async setTags(tags: readonly string[], options?: SetTagsOptions): Promise<void> {
		const source = options?.source ?? "user";
		if (source === "auto" && this._tagsSource === "user") return;
		this._tags = normalizeTags(tags);
		this._tagsSource = source;
	}

	searchBlob(): string | undefined {
		return this._searchBlob;
	}

	// eslint-disable-next-line @typescript-eslint/require-await
	async setSearchBlob(blob: string): Promise<void> {
		this._searchBlob = blob;
	}
}
