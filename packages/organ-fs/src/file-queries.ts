// Re-export barrel — find and grep tools now live in dedicated modules.
// ls tool kept here (dead code: not exposed as an organ action).
export * from "./file-query-base.js";
export * from "./find-query.js";
export * from "./grep-query.js";

// ---------------------------------------------------------------------------
// ls query (not exposed as an organ action — kept for completeness)
// ---------------------------------------------------------------------------

import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { ToolResultCache, ToolResultCacheHit } from "./cache.js";
import { type BaseToolDetails, type ToolQueryResponse, withCacheHit } from "./file-query-base.js";
import { resolveToCwd } from "./path-utils.js";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from "./truncate.js";

// ============================================================================
// ls query
// ============================================================================

export const DEFAULT_LS_LIMIT = 500;

export interface LsToolInput {
	path?: string;
	limit?: number;
}

export interface LsToolDetails extends BaseToolDetails {
	entryLimitReached?: number;
}

export type LsToolResponse = ToolQueryResponse<LsToolDetails>;

interface LsStatResult {
	isDirectory: () => boolean;
}

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

export async function executeLsQuery(input: LsToolInput, options: LsQueryOptions): Promise<LsToolResponse> {
	const ops = options.operations ?? defaultLsOperations;
	const cache = options.cache;
	const signal = options.signal;
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Operation aborted"));
			return;
		}

		let settled = false;
		const settle = (fn: () => void) => {
			if (settled) {
				return;
			}
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			fn();
		};
		const onAbort = () => {
			settle(() => reject(new Error("Operation aborted")));
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		void (async () => {
			try {
				const dirPath = resolveToCwd(input.path || ".", options.cwd);
				const effectiveLimit = input.limit ?? DEFAULT_LS_LIMIT;
				const cacheKey = cache
					? makeLsCacheKey({
							dirPath,
							limit: effectiveLimit,
						})
					: undefined;

				const resolveWithOptionalCache = (response: LsToolResponse): void => {
					if (cache && cacheKey) {
						const storable = structuredClone(response);
						if (storable.details?.cache) {
							delete storable.details.cache;
							if (Object.keys(storable.details).length === 0) {
								storable.details = undefined;
							}
						}
						cache.set(cacheKey, storable);
					}
					settle(() => resolve(response));
				};

				if (cache && cacheKey) {
					const cachedResponse = withLsCacheHit(cache.get(cacheKey));
					if (cachedResponse) {
						resolveWithOptionalCache(cachedResponse);
						return;
					}
				}

				if (!(await ops.exists(dirPath))) {
					settle(() => reject(new Error(`Path not found: ${dirPath}`)));
					return;
				}

				const stat = await ops.stat(dirPath);
				if (!stat.isDirectory()) {
					settle(() => reject(new Error(`Not a directory: ${dirPath}`)));
					return;
				}

				let entries: string[];
				try {
					entries = await ops.readdir(dirPath);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					settle(() => reject(new Error(`Cannot read directory: ${message}`)));
					return;
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
						if (entryStat.isDirectory()) {
							suffix = "/";
						}
					} catch {
						continue;
					}
					results.push(entry + suffix);
				}

				if (results.length === 0) {
					resolveWithOptionalCache({
						content: [{ type: "text", text: "(empty directory)" }],
						details: undefined,
					});
					return;
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
				if (notices.length > 0) {
					output += `\n\n[${notices.join(". ")}]`;
				}
				resolveWithOptionalCache({
					content: [{ type: "text", text: output }],
					details: Object.keys(details).length > 0 ? details : undefined,
				});
			} catch (error) {
				const normalized = error instanceof Error ? error : new Error(String(error));
				settle(() => reject(normalized));
			}
		})();
	});
}
