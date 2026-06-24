import { InMemoryToolResultCache, NoopToolResultCache, type ToolResultCache } from "./cache.js";

export type FsCacheScope = "grep" | "find" | "ls";

export interface FsRuntimeOptions {
	cacheEnabled?: boolean;
	cacheTtlMs: number;
	cacheMaxEntries: number;
}

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
