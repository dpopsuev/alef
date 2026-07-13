import { InMemoryToolResultCache, NoopToolResultCache, type ToolResultCache } from "./cache.js";

/** Cache partition key identifying which file tool a cache instance serves. */
export type FsCacheScope = "grep" | "find" | "ls";

/** Default hot-path TTL shared by grep/find (OMP-style 1s window). */
export const DEFAULT_FS_CACHE_TTL_MS = 1_000;

/** Configuration for filesystem runtime caches (TTL, max entries, enable/disable). */
export interface FsRuntimeOptions {
	cacheEnabled?: boolean;
	cacheTtlMs?: number;
	cacheMaxEntries?: number;
}

/** Manages per-scope tool result caches for grep, find, and ls queries. */
export class FsRuntime {
	private readonly _cacheEnabled: boolean;
	private readonly _caches: Record<FsCacheScope, ToolResultCache>;

	constructor(options: FsRuntimeOptions = {}) {
		this._cacheEnabled = options.cacheEnabled ?? true;
		const ttlMs = options.cacheTtlMs ?? DEFAULT_FS_CACHE_TTL_MS;
		const maxEntries = options.cacheMaxEntries ?? 256;
		const createCache = (): ToolResultCache =>
			this._cacheEnabled
				? new InMemoryToolResultCache({
						ttlMs,
						maxEntries,
					})
				: new NoopToolResultCache();
		// grep + find share one cache so writes invalidate both hot paths together.
		const searchCache = createCache();
		this._caches = {
			grep: searchCache,
			find: searchCache,
			ls: createCache(),
		};
	}

	getCache(scope: FsCacheScope): ToolResultCache {
		return this._caches[scope];
	}

	clear(): void {
		this._caches.grep.clear();
		// find shares grep's cache — clear once
		if (this._caches.find !== this._caches.grep) {
			this._caches.find.clear();
		}
		this._caches.ls.clear();
	}
}
