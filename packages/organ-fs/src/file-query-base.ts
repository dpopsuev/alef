import path from "node:path";
import type { ToolResultCache, ToolResultCacheHit } from "./cache.js";
import type { TruncationResult } from "./truncate.js";

export type ToolTextContent = Array<{ type: "text"; text: string }>;

export interface BaseToolDetails {
	truncation?: TruncationResult;
	cache?: { hit: boolean; ageMs?: number; ttlMs?: number };
}

export interface ToolQueryResponse<D extends BaseToolDetails> {
	content: ToolTextContent;
	details: D | undefined;
}

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

export function storeAndReturn<D extends BaseToolDetails>(
	response: ToolQueryResponse<D>,
	cache: ToolResultCache | undefined,
	cacheKey: string | undefined,
): ToolQueryResponse<D> {
	if (cache && cacheKey) cache.set(cacheKey, stripCacheMeta(response));
	return response;
}

export function storeAndResolve<D extends BaseToolDetails>(
	response: ToolQueryResponse<D>,
	cache: ToolResultCache | undefined,
	cacheKey: string | undefined,
	resolve: (r: ToolQueryResponse<D>) => void,
): void {
	if (cache && cacheKey) cache.set(cacheKey, stripCacheMeta(response));
	resolve(response);
}

export function withCacheHit<D extends BaseToolDetails>(
	cacheHit: ToolResultCacheHit | undefined,
): ToolQueryResponse<D> | undefined {
	if (!cacheHit) return undefined;
	const cached = cacheHit.value as ToolQueryResponse<D> | undefined;
	if (!cached || !Array.isArray(cached.content)) return undefined;
	const cloned = structuredClone(cached);
	const details: D = {
		...cloned.details,
		cache: { hit: true, ageMs: cacheHit.ageMs, ttlMs: cacheHit.ttlMs },
	} as unknown as D;
	return { ...cloned, details };
}
