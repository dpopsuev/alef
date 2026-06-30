import { InMemoryToolResultCache, NoopToolResultCache, type ToolResultCache } from "./cache.js";

/** Cache partition key identifying which file tool a cache instance serves. */
export type FsCacheScope = "grep" | "find" | "ls";

/** Configuration for filesystem runtime caches (TTL, max entries, enable/disable). */
export interface FsRuntimeOptions {
	cacheEnabled?: boolean;
	cacheTtlMs: number;
	cacheMaxEntries: number;
}

/** Manages per-scope tool result caches for grep, find, and ls queries. */
export class FsRuntime {
	private readonly _cacheEnabled: boolean;
	private readonly _caches: Record<FsCacheScope, ToolResultCache>;

	constructor(options: FsRuntimeOptions) {
		this._cacheEnabled = options.cacheEnabled ?? true;
		const createCache = (): ToolResultCache =>
			this._cacheEnabled
				? new InMemoryToolResultCache({
						ttlMs: options.cacheTtlMs,
						maxEntries: options.cacheMaxEntries,
					})
				: new NoopToolResultCache();
		this._caches = {
			grep: createCache(),
			find: createCache(),
			ls: createCache(),
		};
	}

	getCache(scope: FsCacheScope): ToolResultCache {
		return this._caches[scope];
	}

	clear(): void {
		this._caches.grep.clear();
		this._caches.find.clear();
		this._caches.ls.clear();
	}
}
