import path from "node:path";
import type { ToolResultCache, ToolResultCacheHit } from "./cache.js";
import type { TruncationResult } from "./truncate.js";

/** Array of text-typed content blocks returned by tool queries. */
export type ToolTextContent = Array<{ type: "text"; text: string }>;

/** Common metadata fields shared by all tool query detail payloads. */
export interface BaseToolDetails {
	truncation?: TruncationResult;
	cache?: { hit: boolean; ageMs?: number; ttlMs?: number };
}

/** Standardized response envelope for file tool queries containing content and optional details. */
export interface ToolQueryResponse<D extends BaseToolDetails> {
	content: ToolTextContent;
	details: D | undefined;
}

/** Convert a platform-native path to forward-slash (POSIX) format. */
export function toPosixPath(value: string): string {
	return value.split(path.sep).join("/");
}

function stripCacheMeta<D extends BaseToolDetails>(response: ToolQueryResponse<D>): ToolQueryResponse<D> {
	const storable = structuredClone(response);
	if (storable.details?.cache) {
		delete storable.details.cache;
		if (Object.keys(storable.details).length === 0) storable.details = undefined;
	}
	return storable;
}

/** Optionally store a response in the cache, then return it. */
export function storeAndReturn<D extends BaseToolDetails>(
	response: ToolQueryResponse<D>,
	cache: ToolResultCache | undefined,
	cacheKey: string | undefined,
): ToolQueryResponse<D> {
	if (cache && cacheKey) cache.set(cacheKey, stripCacheMeta(response));
	return response;
}

/** Optionally store a response in the cache, then resolve the given promise callback. */
export function storeAndResolve<D extends BaseToolDetails>(
	response: ToolQueryResponse<D>,
	cache: ToolResultCache | undefined,
	cacheKey: string | undefined,
	resolve: (r: ToolQueryResponse<D>) => void,
): void {
	if (cache && cacheKey) cache.set(cacheKey, stripCacheMeta(response));
	resolve(response);
}

/** Unwrap a cache hit into a ToolQueryResponse with cache metadata attached, or return undefined. */
export function withCacheHit<D extends BaseToolDetails>(
	cacheHit: ToolResultCacheHit | undefined,
): ToolQueryResponse<D> | undefined {
	if (!cacheHit) return undefined;
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- cache stores ToolQueryResponse, runtime-checked below
	const cached = cacheHit.value as ToolQueryResponse<D> | undefined;
	if (!cached || !Array.isArray(cached.content)) return undefined;
	const cloned = structuredClone(cached);
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- extending generic D with cache metadata
	const details: D = {
		...cloned.details,
		cache: { hit: true, ageMs: cacheHit.ageMs, ttlMs: cacheHit.ttlMs },
	} as unknown as D;
	return { ...cloned, details };
}
