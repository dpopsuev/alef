import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { debugLog } from "@dpopsuev/alef-kernel";
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

export const DEFAULT_FIND_LIMIT = 1000;

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

export interface FindToolDetails extends BaseToolDetails {
	resultLimitReached?: number;
}

export type FindToolResponse = ToolQueryResponse<FindToolDetails>;

export interface FindOperations {
	exists: (absolutePath: string) => Promise<boolean> | boolean;
	glob: (pattern: string, cwd: string, options: { ignore: string[]; limit: number }) => Promise<string[]> | string[];
}

const defaultFindOperations: FindOperations = {
	exists: existsSync,
	glob: () => [],
};

export interface FindQueryOptions {
	cwd: string;
	operations?: FindOperations;
	cache?: ToolResultCache;
	signal?: AbortSignal;
	resolveFdPath?: () => Promise<string | undefined>;
	/** Override the 30s hard kill deadline on the fd subprocess. Primarily for tests. */
	subprocessTimeoutMs?: number;
}

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

function withFindCacheHit(cacheHit: ToolResultCacheHit | undefined): FindToolResponse | undefined {
	return withCacheHit<FindToolDetails>(cacheHit);
}

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
					const resultLimitReached = relativized.length >= effectiveLimit;
					const rawOutput = relativized.join("\n");
					const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
					let resultOutput = truncation.content;
					const details: FindToolDetails = {};
					const notices: string[] = [];
					if (resultLimitReached) {
						notices.push(`${effectiveLimit} results limit reached`);
						details.resultLimitReached = effectiveLimit;
					}
					if (truncation.truncated) {
						notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
						details.truncation = truncation;
					}
					if (notices.length > 0) {
						resultOutput += `\n\n[${notices.join(". ")}]`;
					}
					resolveWithOptionalCache({
						content: [{ type: "text", text: resultOutput }],
						details: Object.keys(details).length > 0 ? details : undefined,
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
				];
				if (hidden !== false) {
					args.push("--hidden");
				}
				if (entryType) {
					const fdType = entryType === "file" ? "f" : entryType === "directory" ? "d" : "l";
					args.push("--type", fdType);
				}
				if (extension) {
					args.push("--extension", extension.replace(/^\./, ""));
				}
				if (depth !== undefined && depth >= 0) {
					args.push("--max-depth", String(depth));
				}

				let effectivePattern = pattern;
				if (pattern.includes("/")) {
					args.push("--full-path");
					if (!pattern.startsWith("/") && !pattern.startsWith("**/") && pattern !== "**") {
						effectivePattern = `**/${pattern}`;
					}
				}
				args.push("--", effectivePattern, searchPath);

				debugLog("fs:find:spawn", { cmd: fdPath, args, pattern: effectivePattern, searchPath });
				const child = spawn(fdPath, args, { stdio: ["ignore", "pipe", "pipe"] });
				if (!child.stdout) {
					settle(() => reject(new Error("Failed to read fd stdout")));
					return;
				}
				const rl = createInterface({ input: child.stdout });
				let stderr = "";
				const lines: string[] = [];

				stopChild = () => {
					if (!child.killed) {
						child.kill();
					}
				};

				const fdStart = Date.now();
				const fdKillTimer = setTimeout(() => {
					debugLog("fs:find:timeout", { elapsedMs: Date.now() - fdStart, pattern: effectivePattern, searchPath });
					stopChild?.();
					settle(() =>
						reject(
							new Error(
								`fs.find: fd timed out after ${FD_SUBPROCESS_TIMEOUT_MS / 1000}s — pattern may be too broad`,
							),
						),
					);
				}, FD_SUBPROCESS_TIMEOUT_MS);

				const cleanup = () => {
					rl.close();
					clearTimeout(fdKillTimer);
				};

				child.stderr?.on("data", (chunk: Buffer | string) => {
					stderr += chunk.toString();
				});

				rl.on("line", (line) => {
					lines.push(line);
				});

				child.on("error", (error) => {
					cleanup();
					settle(() => reject(new Error(`Failed to run fd: ${error.message}`)));
				});

				child.on("close", (code) => {
					debugLog("fs:find:close", {
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

					const resultLimitReached = relativized.length >= effectiveLimit;
					const rawOutput = relativized.join("\n");
					const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
					let resultOutput = truncation.content;
					const details: FindToolDetails = {};
					const notices: string[] = [];
					if (resultLimitReached) {
						notices.push(
							`${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
						);
						details.resultLimitReached = effectiveLimit;
					}
					if (truncation.truncated) {
						notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
						details.truncation = truncation;
					}
					if (notices.length > 0) {
						resultOutput += `\n\n[${notices.join(". ")}]`;
					}
					resolveWithOptionalCache({
						content: [{ type: "text", text: resultOutput }],
						details: Object.keys(details).length > 0 ? details : undefined,
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
