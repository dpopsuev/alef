import path from "node:path";
import type { ToolResultCacheHit } from "./cache.js";
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
