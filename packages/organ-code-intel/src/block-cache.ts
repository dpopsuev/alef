/**
 * BlockCache — session-scoped file content + symbol cache.
 *
 * Coherence guarantee: write() and edit() always call invalidate(path)
 * before resolving, so stale entries are never served.
 *
 * Cache key: absolute path.
 * Cache value: { content, symbols, mtime } where mtime is wall-clock ms
 * at the time of the last read from disk.
 *
 * This is the backend-internal cache. It is distinct from the EDA framework's
 * shouldCache/invalidates cache, which operates at the motor-event level.
 * The two layers are complementary:
 *   - Framework cache: full ReadResult per (path, opts) — avoids re-entering
 *     the organ entirely on repeated identical calls.
 *   - BlockCache: content + symbols per path — avoids re-reading disk and
 *     re-running the symbol extractor when different opts hit the same file.
 */

import type { SymbolBlock } from "./backend.js";

export interface CacheEntry {
	content: string;
	symbols: SymbolBlock[];
	/** process.hrtime.bigint() at time of cache population. */
	storedAt: bigint;
}

export class BlockCache {
	private readonly map = new Map<string, CacheEntry>();

	get(path: string): CacheEntry | undefined {
		return this.map.get(path);
	}

	set(path: string, entry: CacheEntry): void {
		this.map.set(path, entry);
	}

	/** Remove the cache entry for a path. Called before every write or edit. */
	invalidate(path: string): void {
		this.map.delete(path);
	}

	/** Remove all entries. Called on organ unmount. */
	clear(): void {
		this.map.clear();
	}

	get size(): number {
		return this.map.size;
	}
}
