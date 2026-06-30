// Re-export barrel — find and grep tools now live in dedicated modules.
// ls tool kept here (dead code: not exposed as an adapter action).
export * from "./file-query-base.js";
export * from "./find-query.js";
export * from "./grep-query.js";

// ---------------------------------------------------------------------------
// ls query (not exposed as an adapter action — kept for completeness)
// ---------------------------------------------------------------------------

import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { ToolResultCache, ToolResultCacheHit } from "./cache.js";
import { type BaseToolDetails, storeAndReturn, type ToolQueryResponse, withCacheHit } from "./file-query-base.js";
import { resolveToCwd } from "./path-utils.js";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from "./truncate.js";

// ============================================================================
// ls query
// ============================================================================

/** Maximum number of entries returned by ls queries by default. */
export const DEFAULT_LS_LIMIT = 500;

/** Input parameters for the ls directory listing query. */
export interface LsToolInput {
	path?: string;
	limit?: number;
}

/** Extended details for ls query responses, including entry limit info. */
export interface LsToolDetails extends BaseToolDetails {
	entryLimitReached?: number;
}

/** Response type for ls directory listing queries. */
export type LsToolResponse = ToolQueryResponse<LsToolDetails>;

interface LsStatResult {
	isDirectory: () => boolean;
}

/** Pluggable filesystem operations for the ls query (enables test injection). */
export interface LsOperations {
	exists: (absolutePath: string) => Promise<boolean> | boolean;
	stat: (absolutePath: string) => Promise<LsStatResult> | LsStatResult;
	readdir: (absolutePath: string) => Promise<string[]> | string[];
}

const defaultLsOperations: LsOperations = {
	exists: existsSync,
	stat: statSync,
	readdir: readdirSync,
};

/** Options for executing an ls directory listing query. */
export interface LsQueryOptions {
	cwd: string;
	operations?: LsOperations;
	cache?: ToolResultCache;
	signal?: AbortSignal;
}

function makeLsCacheKey(input: { dirPath: string; limit: number }): string {
	return JSON.stringify({
		v: 1,
		tool: "file_ls",
		dirPath: input.dirPath,
		limit: input.limit,
	});
}

function withLsCacheHit(cacheHit: ToolResultCacheHit | undefined): LsToolResponse | undefined {
	return withCacheHit<LsToolDetails>(cacheHit);
}

/** List directory entries with sorting, truncation, and optional caching. */
export async function executeLsQuery(input: LsToolInput, options: LsQueryOptions): Promise<LsToolResponse> {
	const ops = options.operations ?? defaultLsOperations;
	const cache = options.cache;
	const signal = options.signal;

	signal?.throwIfAborted();

	// eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty string must fall through to "."
	const dirPath = resolveToCwd(input.path || ".", options.cwd);
	const effectiveLimit = input.limit ?? DEFAULT_LS_LIMIT;
	const cacheKey = cache ? makeLsCacheKey({ dirPath, limit: effectiveLimit }) : undefined;

	if (cache && cacheKey) {
		const cached = withLsCacheHit(cache.get(cacheKey));
		if (cached) return cached;
	}

	if (!(await ops.exists(dirPath))) throw new Error(`Path not found: ${dirPath}`);

	const stat = await ops.stat(dirPath);
	if (!stat.isDirectory()) throw new Error(`Not a directory: ${dirPath}`);

	signal?.throwIfAborted();

	let entries: string[];
	try {
		entries = await ops.readdir(dirPath);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Cannot read directory: ${message}`);
	}

	entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

	const results: string[] = [];
	let entryLimitReached = false;
	for (const entry of entries) {
		if (results.length >= effectiveLimit) {
			entryLimitReached = true;
			break;
		}
		const fullPath = path.join(dirPath, entry);
		let suffix = "";
		try {
			const entryStat = await ops.stat(fullPath);
			if (entryStat.isDirectory()) suffix = "/";
		} catch {
			continue;
		}
		results.push(entry + suffix);
	}

	if (results.length === 0) {
		return storeAndReturn(
			{ content: [{ type: "text", text: "(empty directory)" }], details: undefined },
			cache,
			cacheKey,
		);
	}

	const rawOutput = results.join("\n");
	const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
	let output = truncation.content;
	const details: LsToolDetails = {};
	const notices: string[] = [];
	if (entryLimitReached) {
		notices.push(`${effectiveLimit} entries limit reached. Use limit=${effectiveLimit * 2} for more`);
		details.entryLimitReached = effectiveLimit;
	}
	if (truncation.truncated) {
		notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
		details.truncation = truncation;
	}
	if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;

	return storeAndReturn(
		{ content: [{ type: "text", text: output }], details: Object.keys(details).length > 0 ? details : undefined },
		cache,
		cacheKey,
	);
}
