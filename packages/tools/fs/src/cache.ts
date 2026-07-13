/** A cache hit containing the stored value and its age/TTL metadata. */
export interface ToolResultCacheHit {
	value: unknown;
	ageMs: number;
	ttlMs: number;
}

/** Key-value cache contract for memoizing tool query results. */
export interface ToolResultCache {
	get(key: string): ToolResultCacheHit | undefined;
	set(key: string, value: unknown): void;
	clear(): void;
}

/** Options for the in-memory LRU cache with TTL-based expiration. */
export interface InMemoryToolResultCacheOptions {
	ttlMs?: number;
	maxEntries?: number;
}

interface CacheEntry {
	value: unknown;
	createdAt: number;
	expiresAt: number;
}

const DEFAULT_TTL_MS = 1_000;
const DEFAULT_MAX_ENTRIES = 256;

/** LRU cache with TTL expiration and configurable max entries for tool results. */
export class InMemoryToolResultCache implements ToolResultCache {
	private readonly _ttlMs: number;
	private readonly _maxEntries: number;
	private readonly _entries = new Map<string, CacheEntry>();

	constructor(options: InMemoryToolResultCacheOptions = {}) {
		this._ttlMs = Math.max(1, Math.floor(options.ttlMs ?? DEFAULT_TTL_MS));
		this._maxEntries = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_MAX_ENTRIES));
	}

	get(key: string): ToolResultCacheHit | undefined {
		const now = Date.now();
		this._evictExpired(now);
		const entry = this._entries.get(key);
		if (!entry) {
			return undefined;
		}
		if (entry.expiresAt <= now) {
			this._entries.delete(key);
			return undefined;
		}

		this._entries.delete(key);
		this._entries.set(key, entry);

		return {
			value: entry.value,
			ageMs: Math.max(0, now - entry.createdAt),
			ttlMs: this._ttlMs,
		};
	}

	set(key: string, value: unknown): void {
		const now = Date.now();
		this._evictExpired(now);
		this._entries.delete(key);
		this._entries.set(key, {
			value,
			createdAt: now,
			expiresAt: now + this._ttlMs,
		});
		this._evictOverflow();
	}

	clear(): void {
		this._entries.clear();
	}

	private _evictExpired(now: number): void {
		for (const [key, entry] of this._entries.entries()) {
			if (entry.expiresAt <= now) {
				this._entries.delete(key);
			}
		}
	}

	private _evictOverflow(): void {
		while (this._entries.size > this._maxEntries) {
			const oldest = this._entries.keys().next().value;
			if (oldest === undefined) {
				return;
			}
			this._entries.delete(oldest);
		}
	}
}

/** No-op cache implementation that never stores or returns values. */
export class NoopToolResultCache implements ToolResultCache {
	get(_key: string): ToolResultCacheHit | undefined {
		return undefined;
	}

	set(_key: string, _value: unknown): void {}

	clear(): void {}
}
