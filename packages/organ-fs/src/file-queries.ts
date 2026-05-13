import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import type { ToolResultCache, ToolResultCacheHit } from "./cache.js";
import { resolveToCwd } from "./path-utils.js";
import {
	DEFAULT_MAX_BYTES,
	formatSize,
	GREP_MAX_LINE_LENGTH,
	type TruncationResult,
	truncateHead,
	truncateLine,
} from "./truncate.js";

type ToolTextContent = Array<{ type: "text"; text: string }>;

function toPosixPath(value: string): string {
	return value.split(path.sep).join("/");
}

// ============================================================================
// find query
// ============================================================================

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

export interface FindToolDetails {
	truncation?: TruncationResult;
	resultLimitReached?: number;
	cache?: {
		hit: boolean;
		ageMs?: number;
		ttlMs?: number;
	};
}

export interface FindToolResponse {
	content: ToolTextContent;
	details: FindToolDetails | undefined;
}

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
	if (!cacheHit) {
		return undefined;
	}
	const cached = cacheHit.value as FindToolResponse | undefined;
	if (!cached || !Array.isArray(cached.content)) {
		return undefined;
	}
	const cloned = structuredClone(cached) as FindToolResponse;
	return {
		...cloned,
		details: {
			...(cloned.details ?? {}),
			cache: {
				hit: true,
				ageMs: cacheHit.ageMs,
				ttlMs: cacheHit.ttlMs,
			},
		},
	};
}

export async function executeFindQuery(input: FindToolInput, options: FindQueryOptions): Promise<FindToolResponse> {
	const customOps = options.operations;
	const cache = options.cache;
	const signal = options.signal;
	const resolveFdPath = options.resolveFdPath ?? (async () => "fd");
	const { pattern, path: searchDir, limit, type: entryType, extension, depth, hidden } = input;
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Operation aborted"));
			return;
		}

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

		(async () => {
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

				const resolveWithOptionalCache = (response: FindToolResponse): void => {
					if (cache && cacheKey) {
						const storable = structuredClone(response) as FindToolResponse;
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

				const cleanup = () => {
					rl.close();
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

// ============================================================================
// grep query
// ============================================================================

export const DEFAULT_GREP_LIMIT = 100;

export interface GrepToolInput {
	pattern: string;
	path?: string;
	glob?: string;
	ignoreCase?: boolean;
	literal?: boolean;
	context?: number;
	limit?: number;
	/** Filter by file type, e.g. 'ts', 'go', 'py' (rg --type). */
	type?: string;
	/** Return only file paths that contain matches, no line content (rg -l). */
	filesWithMatches?: boolean;
	/** Return match count per file, no content (rg --count). */
	countOnly?: boolean;
}

export interface GrepToolDetails {
	truncation?: TruncationResult;
	matchLimitReached?: number;
	linesTruncated?: boolean;
	cache?: {
		hit: boolean;
		ageMs?: number;
		ttlMs?: number;
	};
}

export interface GrepToolResponse {
	content: ToolTextContent;
	details: GrepToolDetails | undefined;
}

export interface GrepOperations {
	isDirectory: (absolutePath: string) => Promise<boolean> | boolean;
	readFile: (absolutePath: string) => Promise<string> | string;
}

const defaultGrepOperations: GrepOperations = {
	isDirectory: (entryPath) => statSync(entryPath).isDirectory(),
	readFile: (entryPath) => readFileSync(entryPath, "utf-8"),
};

export interface GrepQueryOptions {
	cwd: string;
	operations?: GrepOperations;
	cache?: ToolResultCache;
	signal?: AbortSignal;
	resolveRgPath?: () => Promise<string | undefined>;
}

interface ParsedGrepMatch {
	filePath: string;
	lineNumber: number;
	lineText?: string;
}

interface RgMatchEvent {
	type?: string;
	data?: {
		path?: { text?: string };
		line_number?: number;
		lines?: { text?: string };
	};
}

function parseGrepMatch(line: string): ParsedGrepMatch | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined;
	}
	const event = parsed as RgMatchEvent;
	if (event.type !== "match") {
		return undefined;
	}
	const filePath = event.data?.path?.text;
	const lineNumber = event.data?.line_number;
	const lineText = event.data?.lines?.text;
	if (!filePath || typeof lineNumber !== "number") {
		return undefined;
	}
	return { filePath, lineNumber, lineText };
}

function makeGrepCacheKey(input: {
	pattern: string;
	searchPath: string;
	glob?: string;
	ignoreCase?: boolean;
	literal?: boolean;
	context: number;
	limit: number;
	type?: string;
	filesWithMatches?: boolean;
	countOnly?: boolean;
}): string {
	return JSON.stringify({
		v: 1,
		tool: "file_grep",
		pattern: input.pattern,
		searchPath: input.searchPath,
		glob: input.glob ?? null,
		ignoreCase: input.ignoreCase ?? false,
		literal: input.literal ?? false,
		context: input.context,
		limit: input.limit,
		type: input.type ?? null,
		filesWithMatches: input.filesWithMatches ?? false,
		countOnly: input.countOnly ?? false,
	});
}

function withGrepCacheHit(cacheHit: ToolResultCacheHit | undefined): GrepToolResponse | undefined {
	if (!cacheHit) {
		return undefined;
	}
	const cached = cacheHit.value as GrepToolResponse | undefined;
	if (!cached || !Array.isArray(cached.content)) {
		return undefined;
	}
	const cloned = structuredClone(cached) as GrepToolResponse;
	return {
		...cloned,
		details: {
			...(cloned.details ?? {}),
			cache: {
				hit: true,
				ageMs: cacheHit.ageMs,
				ttlMs: cacheHit.ttlMs,
			},
		},
	};
}

export async function executeGrepQuery(input: GrepToolInput, options: GrepQueryOptions): Promise<GrepToolResponse> {
	const customOps = options.operations;
	const cache = options.cache;
	const signal = options.signal;
	const resolveRgPath = options.resolveRgPath ?? (async () => "rg");
	const {
		pattern,
		path: searchDir,
		glob,
		ignoreCase,
		literal,
		context,
		limit,
		type: fileType,
		filesWithMatches,
		countOnly,
	} = input;
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Operation aborted"));
			return;
		}
		let settled = false;
		const settle = (fn: () => void) => {
			if (!settled) {
				settled = true;
				fn();
			}
		};

		(async () => {
			try {
				const rgPath = await resolveRgPath();
				if (!rgPath) {
					settle(() => reject(new Error("ripgrep (rg) is not available and could not be downloaded")));
					return;
				}

				const searchPath = resolveToCwd(searchDir || ".", options.cwd);
				const ops = customOps ?? defaultGrepOperations;
				let isDirectory: boolean;
				try {
					isDirectory = await ops.isDirectory(searchPath);
				} catch {
					settle(() => reject(new Error(`Path not found: ${searchPath}`)));
					return;
				}

				const contextValue = context && context > 0 ? context : 0;
				const effectiveLimit = Math.max(1, limit ?? DEFAULT_GREP_LIMIT);
				const cacheKey = cache
					? makeGrepCacheKey({
							pattern,
							searchPath,
							glob,
							ignoreCase,
							literal,
							context: contextValue,
							limit: effectiveLimit,
							type: fileType,
							filesWithMatches,
							countOnly,
						})
					: undefined;
				const resolveWithOptionalCache = (response: GrepToolResponse): void => {
					if (cache && cacheKey) {
						const storable = structuredClone(response) as GrepToolResponse;
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
					const cachedResponse = withGrepCacheHit(cache.get(cacheKey));
					if (cachedResponse) {
						settle(() => resolve(cachedResponse));
						return;
					}
				}
				const formatPath = (filePath: string): string => {
					if (isDirectory) {
						const relative = path.relative(searchPath, filePath);
						if (relative && !relative.startsWith("..")) {
							return relative.replace(/\\/g, "/");
						}
					}
					return path.basename(filePath);
				};

				const fileCache = new Map<string, string[]>();
				const getFileLines = async (filePath: string): Promise<string[]> => {
					let lines = fileCache.get(filePath);
					if (!lines) {
						try {
							const content = await ops.readFile(filePath);
							lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
						} catch {
							lines = [];
						}
						fileCache.set(filePath, lines);
					}
					return lines;
				};

				// filesWithMatches and countOnly use plain-text rg output, not JSON
				const useJsonMode = !filesWithMatches && !countOnly;
				const args: string[] = useJsonMode
					? ["--json", "--line-number", "--color=never", "--hidden"]
					: ["--color=never", "--hidden"];
				if (filesWithMatches) {
					args.push("--files-with-matches");
				} else if (countOnly) {
					args.push("--count");
				}
				if (ignoreCase) {
					args.push("--ignore-case");
				}
				if (literal) {
					args.push("--fixed-strings");
				}
				if (glob) {
					args.push("--glob", glob);
				}
				if (fileType) {
					args.push("--type", fileType);
				}
				args.push("--", pattern, searchPath);

				const child = spawn(rgPath, args, { stdio: ["ignore", "pipe", "pipe"] });
				if (!child.stdout) {
					settle(() => reject(new Error("Failed to read ripgrep stdout")));
					return;
				}
				const rl = createInterface({ input: child.stdout });
				let stderr = "";
				let matchCount = 0;
				let matchLimitReached = false;
				let linesTruncated = false;
				let aborted = false;
				let killedDueToLimit = false;
				const outputLines: string[] = [];

				const cleanup = () => {
					rl.close();
					signal?.removeEventListener("abort", onAbort);
				};
				const stopChild = (dueToLimit = false) => {
					if (!child.killed) {
						killedDueToLimit = dueToLimit;
						child.kill();
					}
				};
				const onAbort = () => {
					aborted = true;
					stopChild();
				};
				signal?.addEventListener("abort", onAbort, { once: true });

				child.stderr?.on("data", (chunk: Buffer | string) => {
					stderr += chunk.toString();
				});

				const formatBlock = async (filePath: string, lineNumber: number): Promise<string[]> => {
					const relativePath = formatPath(filePath);
					const lines = await getFileLines(filePath);
					if (!lines.length) {
						return [`${relativePath}:${lineNumber}: (unable to read file)`];
					}
					const block: string[] = [];
					const start = contextValue > 0 ? Math.max(1, lineNumber - contextValue) : lineNumber;
					const end = contextValue > 0 ? Math.min(lines.length, lineNumber + contextValue) : lineNumber;
					for (let current = start; current <= end; current++) {
						const lineText = lines[current - 1] ?? "";
						const sanitized = lineText.replace(/\r/g, "");
						const isMatchLine = current === lineNumber;
						const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
						if (wasTruncated) {
							linesTruncated = true;
						}
						if (isMatchLine) {
							block.push(`${relativePath}:${current}: ${truncatedText}`);
						} else {
							block.push(`${relativePath}-${current}- ${truncatedText}`);
						}
					}
					return block;
				};

				const matches: ParsedGrepMatch[] = [];
				rl.on("line", (line) => {
					if (!line.trim() || matchCount >= effectiveLimit) {
						return;
					}
					if (!useJsonMode) {
						// Plain-text mode (filesWithMatches / countOnly): each line is a result
						matchCount++;
						outputLines.push(line.replace(/\r$/, ""));
						if (matchCount >= effectiveLimit) {
							matchLimitReached = true;
							stopChild(true);
						}
						return;
					}
					const parsed = parseGrepMatch(line);
					if (!parsed) {
						return;
					}
					matchCount++;
					matches.push(parsed);
					if (matchCount >= effectiveLimit) {
						matchLimitReached = true;
						stopChild(true);
					}
				});

				child.on("error", (error) => {
					cleanup();
					settle(() => reject(new Error(`Failed to run ripgrep: ${error.message}`)));
				});

				child.on("close", async (code) => {
					cleanup();
					if (aborted) {
						settle(() => reject(new Error("Operation aborted")));
						return;
					}
					if (!killedDueToLimit && code !== 0 && code !== 1) {
						const errorMsg = stderr.trim() || `ripgrep exited with code ${code}`;
						settle(() => reject(new Error(errorMsg)));
						return;
					}
					if (matchCount === 0) {
						resolveWithOptionalCache({
							content: [{ type: "text", text: "No matches found" }],
							details: undefined,
						});
						return;
					}
					// Plain-text mode: output is already assembled in outputLines
					if (!useJsonMode) {
						const rawOutput = outputLines.join("\n");
						const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
						let output = truncation.content;
						const details: GrepToolDetails = {};
						const notices: string[] = [];
						if (matchLimitReached) {
							notices.push(`${effectiveLimit} results limit reached`);
							details.matchLimitReached = effectiveLimit;
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
						return;
					}

					for (const match of matches) {
						if (contextValue === 0 && match.lineText !== undefined) {
							const relativePath = formatPath(match.filePath);
							const sanitized = match.lineText.replace(/\r\n/g, "\n").replace(/\r/g, "").replace(/\n$/, "");
							const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
							if (wasTruncated) {
								linesTruncated = true;
							}
							outputLines.push(`${relativePath}:${match.lineNumber}: ${truncatedText}`);
						} else {
							const block = await formatBlock(match.filePath, match.lineNumber);
							outputLines.push(...block);
						}
					}

					const rawOutput = outputLines.join("\n");
					const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
					let output = truncation.content;
					const details: GrepToolDetails = {};
					const notices: string[] = [];
					if (matchLimitReached) {
						notices.push(
							`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
						);
						details.matchLimitReached = effectiveLimit;
					}
					if (truncation.truncated) {
						notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
						details.truncation = truncation;
					}
					if (linesTruncated) {
						notices.push(
							`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use file_read to see full lines`,
						);
						details.linesTruncated = true;
					}
					if (notices.length > 0) {
						output += `\n\n[${notices.join(". ")}]`;
					}
					resolveWithOptionalCache({
						content: [{ type: "text", text: output }],
						details: Object.keys(details).length > 0 ? details : undefined,
					});
				});
			} catch (error) {
				const normalized = error instanceof Error ? error : new Error(String(error));
				settle(() => reject(normalized));
			}
		})();
	});
}

// ============================================================================
// ls query
// ============================================================================

export const DEFAULT_LS_LIMIT = 500;

export interface LsToolInput {
	path?: string;
	limit?: number;
}

export interface LsToolDetails {
	truncation?: TruncationResult;
	entryLimitReached?: number;
	cache?: {
		hit: boolean;
		ageMs?: number;
		ttlMs?: number;
	};
}

export interface LsToolResponse {
	content: ToolTextContent;
	details: LsToolDetails | undefined;
}

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
	if (!cacheHit) {
		return undefined;
	}
	const cached = cacheHit.value as LsToolResponse | undefined;
	if (!cached || !Array.isArray(cached.content)) {
		return undefined;
	}
	const cloned = structuredClone(cached) as LsToolResponse;
	return {
		...cloned,
		details: {
			...(cloned.details ?? {}),
			cache: {
				hit: true,
				ageMs: cacheHit.ageMs,
				ttlMs: cacheHit.ttlMs,
			},
		},
	};
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

		(async () => {
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
						const storable = structuredClone(response) as LsToolResponse;
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
