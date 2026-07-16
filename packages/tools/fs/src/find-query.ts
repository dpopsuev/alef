import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { Watchdog } from "@dpopsuev/alef-kernel/bus";
import { traceEvent } from "@dpopsuev/alef-kernel/log";
import type { ToolResultCache, ToolResultCacheHit } from "./cache.js";
import {
	type BaseToolDetails,
	storeAndResolve,
	type ToolQueryResponse,
	toPosixPath,
	withCacheHit,
} from "./file-query-base.js";
import { resolveToCwd } from "./path-utils.js";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from "./truncate.js";

/** Maximum number of results returned by find queries by default. */
export const DEFAULT_FIND_LIMIT = 1000;

/** Input parameters for the fd-backed file find query. */
export interface FindToolInput {
	pattern: string;
	path?: string;
	limit?: number;
	/** Filter by entry type: 'file', 'directory', or 'symlink' (fd -t). */
	type?: "file" | "directory" | "symlink";
	/** Filter by file extension, e.g. 'ts' or '.ts' (fd -e). */
	extension?: string;
	/** Maximum directory depth to descend (fd --max-depth). */
	depth?: number;
	/** Include hidden files and directories (default: true). Set false to exclude dotfiles. */
	hidden?: boolean;
}

/** Extended details for find query responses, including result limit info. */
export interface FindToolDetails extends BaseToolDetails {
	resultLimitReached?: number;
}

/** Response type for file find queries. */
export type FindToolResponse = ToolQueryResponse<FindToolDetails>;

/** Map user-facing entry type names to fd's single-char type flags. */
const FD_TYPE_FLAG: Record<string, string> = {
	file: "f",
	directory: "d",
	symlink: "l",
};

/**
 *
 */
function killSubprocessTree(pid: number | undefined): void {
	if (!pid) return;
	if (process.platform === "win32") {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			/* process already dead */
		}
		return;
	}
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			/* process already dead */
		}
	}
}

/** Rules for conditionally appending fd CLI arguments based on query input. */
const FD_ARG_RULES: {
	test: (input: FindToolInput) => boolean;
	args: (input: FindToolInput) => string[];
}[] = [
	{ test: (i) => i.hidden !== false, args: () => ["--hidden"] },
	{
		test: (i) => i.type !== undefined,
		args: (i) => ["--type", FD_TYPE_FLAG[i.type!]!],
	},
	{
		test: (i) => i.extension !== undefined,
		args: (i) => ["--extension", i.extension!.replace(/^\./, "")],
	},
	{
		test: (i) => i.depth !== undefined && i.depth >= 0,
		args: (i) => ["--max-depth", String(i.depth)],
	},
];

/** Context passed to notice rules during result formatting. */
interface FindNoticeContext {
	resultCount: number;
	effectiveLimit: number;
	truncation: ReturnType<typeof truncateHead>;
	/** When true, the limit-reached notice includes a hint to increase the limit. */
	showLimitHint: boolean;
}

/** Rules for appending limit/truncation notices and populating response details. */
const FIND_NOTICE_RULES: {
	test: (ctx: FindNoticeContext) => boolean;
	notice: (ctx: FindNoticeContext) => string;
	apply: (ctx: FindNoticeContext, details: FindToolDetails) => void;
}[] = [
	{
		test: (ctx) => ctx.resultCount >= ctx.effectiveLimit,
		notice: (ctx) =>
			ctx.showLimitHint
				? `${ctx.effectiveLimit} results limit reached. Use limit=${ctx.effectiveLimit * 2} for more, or refine pattern`
				: `${ctx.effectiveLimit} results limit reached`,
		apply: (ctx, d) => {
			d.resultLimitReached = ctx.effectiveLimit;
		},
	},
	{
		test: (ctx) => ctx.truncation.truncated === true,
		notice: () => `${formatSize(DEFAULT_MAX_BYTES)} limit reached`,
		apply: (ctx, d) => {
			d.truncation = ctx.truncation;
		},
	},
];

/**
 * Apply notice rules to a find result, returning the final output text and
 * optional details object ready for caching.
 */
function applyFindNotices(
	baseOutput: string,
	ctx: FindNoticeContext,
): { resultOutput: string; details: FindToolDetails | undefined } {
	const details: FindToolDetails = {};
	const matched = FIND_NOTICE_RULES.filter((r) => r.test(ctx));
	for (const rule of matched) {
		rule.apply(ctx, details);
	}
	const notices = matched.map((r) => r.notice(ctx));
	const resultOutput = notices.length > 0 ? `${baseOutput}\n\n[${notices.join(". ")}]` : baseOutput;
	return {
		resultOutput,
		details: Object.keys(details).length > 0 ? details : undefined,
	};
}

/** Pluggable filesystem operations for the find query (enables test injection). */
export interface FindOperations {
	exists: (absolutePath: string) => Promise<boolean> | boolean;
	glob: (pattern: string, cwd: string, options: { ignore: string[]; limit: number }) => Promise<string[]> | string[];
}

const defaultFindOperations: FindOperations = {
	exists: existsSync,
	glob: () => [],
};

/** Options for executing a file find query via fd or custom operations. */
export interface FindQueryOptions {
	cwd: string;
	operations?: FindOperations;
	cache?: ToolResultCache;
	signal?: AbortSignal;
	resolveFdPath?: () => Promise<string | undefined>;
	/** Override the 30s hard kill deadline on the fd subprocess. Primarily for tests. */
	subprocessTimeoutMs?: number;
}

/** Build a deterministic cache key for a find query from its parameters. */
function makeFindCacheKey(input: {
	pattern: string;
	searchPath: string;
	limit: number;
	type?: string;
	extension?: string;
	depth?: number;
	hidden?: boolean;
}): string {
	return JSON.stringify({
		v: 1,
		tool: "file_find",
		pattern: input.pattern,
		searchPath: input.searchPath,
		limit: input.limit,
		type: input.type ?? null,
		extension: input.extension ?? null,
		depth: input.depth ?? null,
		hidden: input.hidden ?? true,
	});
}

/** Unwrap a find cache hit into a typed FindToolResponse, or return undefined on miss. */
function withFindCacheHit(cacheHit: ToolResultCacheHit | undefined): FindToolResponse | undefined {
	return withCacheHit<FindToolDetails>(cacheHit);
}

/** Execute a file-find query using fd with glob matching, caching, and truncation. */
export async function executeFindQuery(input: FindToolInput, options: FindQueryOptions): Promise<FindToolResponse> {
	const customOps = options.operations;
	const cache = options.cache;
	const signal = options.signal;
	const resolveFdPath = options.resolveFdPath ?? (() => "fd");
	const { pattern, path: searchDir, limit, type: entryType, extension, depth, hidden } = input;
	signal?.throwIfAborted();

	return new Promise((resolve, reject) => {
		let settled = false;
		let stopChild: (() => void) | undefined;
		const settle = (fn: () => void) => {
			if (settled) {
				return;
			}
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			stopChild = undefined;
			fn();
		};
		const onAbort = () => {
			stopChild?.();
			settle(() => reject(new Error("Operation aborted")));
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		void (async () => {
			try {
				// eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty string must fall through to "."
				const searchPath = resolveToCwd(searchDir || ".", options.cwd);
				const effectiveLimit = limit ?? DEFAULT_FIND_LIMIT;
				const ops = customOps ?? defaultFindOperations;
				const cacheKey = cache
					? makeFindCacheKey({
							pattern,
							searchPath,
							limit: effectiveLimit,
							type: entryType,
							extension,
							depth,
							hidden,
						})
					: undefined;

				const resolveWithOptionalCache = (response: FindToolResponse): void =>
					storeAndResolve(response, cache, cacheKey, (r) => settle(() => resolve(r)));

				if (cache && cacheKey) {
					const cachedResponse = withFindCacheHit(cache.get(cacheKey));
					if (cachedResponse) {
						settle(() => resolve(cachedResponse));
						return;
					}
				}

				if (customOps?.glob) {
					if (!(await ops.exists(searchPath))) {
						settle(() => reject(new Error(`Path not found: ${searchPath}`)));
						return;
					}
					if (signal?.aborted) {
						settle(() => reject(new Error("Operation aborted")));
						return;
					}

					const results = await ops.glob(pattern, searchPath, {
						ignore: ["**/node_modules/**", "**/.git/**"],
						limit: effectiveLimit,
					});
					if (signal?.aborted) {
						settle(() => reject(new Error("Operation aborted")));
						return;
					}

					if (results.length === 0) {
						resolveWithOptionalCache({
							content: [{ type: "text", text: "No files found matching pattern" }],
							details: undefined,
						});
						return;
					}

					const relativized = results.map((entryPath) => {
						if (entryPath.startsWith(searchPath)) {
							return toPosixPath(entryPath.slice(searchPath.length + 1));
						}
						return toPosixPath(path.relative(searchPath, entryPath));
					});
					const rawOutput = relativized.join("\n");
					const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
					const { resultOutput, details } = applyFindNotices(truncation.content, {
						resultCount: relativized.length,
						effectiveLimit,
						truncation,
						showLimitHint: false,
					});
					resolveWithOptionalCache({
						content: [{ type: "text", text: resultOutput }],
						details,
					});
					return;
				}

				const fdPath = await resolveFdPath();
				if (signal?.aborted) {
					settle(() => reject(new Error("Operation aborted")));
					return;
				}
				if (!fdPath) {
					settle(() => reject(new Error("fd is not available and could not be downloaded")));
					return;
				}

				const FD_SUBPROCESS_TIMEOUT_MS = options.subprocessTimeoutMs ?? 30_000;

				const args: string[] = [
					"--glob",
					"--color=never",
					"--no-require-git",
					"--max-results",
					String(effectiveLimit),
					...FD_ARG_RULES.filter((r) => r.test(input)).flatMap((r) => r.args(input)),
				];

				let effectivePattern = pattern;
				if (pattern.includes("/")) {
					args.push("--full-path");
					if (!pattern.startsWith("/") && !pattern.startsWith("**/") && pattern !== "**") {
						effectivePattern = `**/${pattern}`;
					}
				}
				args.push("--", effectivePattern, searchPath);

				traceEvent("fs:find:spawn", { cmd: fdPath, args, pattern: effectivePattern, searchPath });
				const child = spawn(fdPath, args, {
					stdio: ["ignore", "pipe", "pipe"],
					detached: process.platform !== "win32",
				});
				const rl = createInterface({ input: child.stdout });
				let stderr = "";
				const lines: string[] = [];

				stopChild = () => {
					killSubprocessTree(child.pid);
				};

				const fdStart = Date.now();
				const fdWatchdog = new Watchdog(FD_SUBPROCESS_TIMEOUT_MS, () => {
					traceEvent("fs:find:timeout", {
						elapsedMs: Date.now() - fdStart,
						pattern: effectivePattern,
						searchPath,
					});
					stopChild?.();
					settle(() =>
						reject(
							new Error(
								`fs.find: fd timed out after ${FD_SUBPROCESS_TIMEOUT_MS / 1000}s — pattern may be too broad`,
							),
						),
					);
				});
				fdWatchdog.start();

				const cleanup = () => {
					rl.close();
					fdWatchdog.stop();
				};

				child.stderr.on("data", (chunk: Buffer | string) => {
					stderr += chunk.toString();
				});

				rl.on("line", (line) => {
					fdWatchdog.reset();
					lines.push(line);
				});

				child.on("error", (error) => {
					cleanup();
					settle(() => reject(new Error(`Failed to run fd: ${error.message}`)));
				});

				child.on("close", (code) => {
					traceEvent("fs:find:close", {
						elapsedMs: Date.now() - fdStart,
						code,
						lines: lines.length,
						pattern: effectivePattern,
					});
					cleanup();
					if (signal?.aborted) {
						settle(() => reject(new Error("Operation aborted")));
						return;
					}
					const output = lines.join("\n");
					if (code !== 0) {
						const errorMsg = stderr.trim() || `fd exited with code ${code}`;
						if (!output) {
							settle(() => reject(new Error(errorMsg)));
							return;
						}
					}
					if (!output) {
						resolveWithOptionalCache({
							content: [{ type: "text", text: "No files found matching pattern" }],
							details: undefined,
						});
						return;
					}

					const relativized: string[] = [];
					for (const rawLine of lines) {
						const line = rawLine.replace(/\r$/, "").trim();
						if (!line) {
							continue;
						}
						const hadTrailingSlash = line.endsWith("/") || line.endsWith("\\");
						let relativePath = line;
						if (line.startsWith(searchPath)) {
							relativePath = line.slice(searchPath.length + 1);
						} else {
							relativePath = path.relative(searchPath, line);
						}
						if (hadTrailingSlash && !relativePath.endsWith("/")) {
							relativePath += "/";
						}
						relativized.push(toPosixPath(relativePath));
					}

					const rawOutput = relativized.join("\n");
					const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
					const { resultOutput, details } = applyFindNotices(truncation.content, {
						resultCount: relativized.length,
						effectiveLimit,
						truncation,
						showLimitHint: true,
					});
					resolveWithOptionalCache({
						content: [{ type: "text", text: resultOutput }],
						details,
					});
				});
			} catch (error) {
				if (signal?.aborted) {
					settle(() => reject(new Error("Operation aborted")));
					return;
				}
				const normalized = error instanceof Error ? error : new Error(String(error));
				settle(() => reject(normalized));
			}
		})();
	});
}
