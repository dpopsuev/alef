import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { traceEvent } from "@dpopsuev/alef-kernel/log";
import type { ToolResultCache, ToolResultCacheHit } from "./cache.js";
import { type BaseToolDetails, storeAndResolve, type ToolQueryResponse, withCacheHit } from "./file-query-base.js";
import { resolveToCwd } from "./path-utils.js";
import { DEFAULT_MAX_BYTES, formatSize, GREP_MAX_LINE_LENGTH, truncateHead, truncateLine } from "./truncate.js";

/** Maximum number of matches returned by grep queries by default. */
export const DEFAULT_GREP_LIMIT = 100;

/** Input parameters for the ripgrep-backed content search query. */
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

/** Extended details for grep query responses, including match limit and truncation info. */
export interface GrepToolDetails extends BaseToolDetails {
	matchLimitReached?: number;
	linesTruncated?: boolean;
	/** True when the search ran in-process against a single file (no rg spawn). */
	inProcess?: boolean;
}

/** Response type for grep content search queries. */
export type GrepToolResponse = ToolQueryResponse<GrepToolDetails>;

/** Pluggable filesystem operations for the grep query (enables test injection). */
export interface GrepOperations {
	isDirectory: (absolutePath: string) => Promise<boolean> | boolean;
	readFile: (absolutePath: string) => Promise<string> | string;
}

const defaultGrepOperations: GrepOperations = {
	isDirectory: (entryPath) => statSync(entryPath).isDirectory(),
	readFile: (entryPath) => readFileSync(entryPath, "utf-8"),
};

/** Options for executing a grep content search query via ripgrep. */
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

/** Parse a single JSON line from ripgrep's --json output into a structured match, or undefined. */
function parseGrepMatch(line: string): ParsedGrepMatch | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined;
	}
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- JSON.parse result narrowed to RgMatchEvent, fields checked below
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

/** Build a deterministic cache key for a grep query from its parameters. */
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

/** Unwrap a grep cache hit into a typed GrepToolResponse, or return undefined on miss. */
function withGrepCacheHit(cacheHit: ToolResultCacheHit | undefined): GrepToolResponse | undefined {
	return withCacheHit<GrepToolDetails>(cacheHit);
}

/** Compile a grep pattern for in-process matching. */
function compilePattern(pattern: string, literal: boolean, ignoreCase: boolean): RegExp {
	const source = literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : pattern;
	return new RegExp(source, ignoreCase ? "i" : undefined);
}

/**
 * Spawn-free grep when `path` points at a single file (no glob/type filters).
 * Avoids forking rg for the common agent hot path of grepping one known file.
 */
export async function grepFileInProcess(
	input: {
		pattern: string;
		filePath: string;
		displayName: string;
		ignoreCase?: boolean;
		literal?: boolean;
		context: number;
		limit: number;
		filesWithMatches?: boolean;
		countOnly?: boolean;
	},
	ops: GrepOperations,
): Promise<GrepToolResponse> {
	const content = await ops.readFile(input.filePath);
	const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
	const regex = compilePattern(input.pattern, input.literal ?? false, input.ignoreCase ?? false);
	const matchLineNumbers: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (regex.test(lines[i]!)) {
			matchLineNumbers.push(i + 1);
			if (matchLineNumbers.length >= input.limit) break;
		}
	}

	const details: GrepToolDetails = { inProcess: true };
	if (matchLineNumbers.length >= input.limit) {
		details.matchLimitReached = input.limit;
	}

	if (input.filesWithMatches) {
		const text = matchLineNumbers.length > 0 ? input.displayName : "";
		return { content: [{ type: "text", text }], details };
	}
	if (input.countOnly) {
		const text = matchLineNumbers.length > 0 ? `${input.displayName}:${matchLineNumbers.length}` : "";
		return { content: [{ type: "text", text }], details };
	}

	const outputLines: string[] = [];
	let linesTruncated = false;
	for (const lineNumber of matchLineNumbers) {
		const start = input.context > 0 ? Math.max(1, lineNumber - input.context) : lineNumber;
		const end = input.context > 0 ? Math.min(lines.length, lineNumber + input.context) : lineNumber;
		for (let current = start; current <= end; current++) {
			const lineText = lines[current - 1] ?? "";
			const { text: truncatedText, wasTruncated } = truncateLine(lineText.replace(/\r/g, ""));
			if (wasTruncated) linesTruncated = true;
			if (current === lineNumber) {
				outputLines.push(`${input.displayName}:${current}: ${truncatedText}`);
			} else {
				outputLines.push(`${input.displayName}-${current}- ${truncatedText}`);
			}
		}
	}
	if (linesTruncated) details.linesTruncated = true;
	const truncation = truncateHead(outputLines.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
	let output = truncation.content;
	const notices: string[] = [];
	if (details.matchLimitReached) {
		notices.push(
			`${input.limit} matches limit reached. Use limit=${input.limit * 2} for more, or refine pattern`,
		);
	}
	if (truncation.truncated) {
		notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
		details.truncation = truncation;
	}
	if (linesTruncated) {
		notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use file_read to see full lines`);
	}
	if (notices.length > 0) {
		output += `\n\n[${notices.join(". ")}]`;
	}
	return { content: [{ type: "text", text: output }], details };
}

/** Execute a ripgrep content search with caching, context lines, and truncation. */
export async function executeGrepQuery(input: GrepToolInput, options: GrepQueryOptions): Promise<GrepToolResponse> {
	const customOps = options.operations;
	const cache = options.cache;
	const signal = options.signal;
	const resolveRgPath = options.resolveRgPath ?? (() => Promise.resolve("rg"));
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

	signal?.throwIfAborted();

	return new Promise((resolve, reject) => {
		let settled = false;
		const settle = (fn: () => void) => {
			if (!settled) {
				settled = true;
				fn();
			}
		};
		signal?.addEventListener("abort", () => settle(() => reject(new Error("Operation aborted"))), { once: true });

		void (async () => {
			try {
				// eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty string must fall through to "."
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
				const resolveWithOptionalCache = (response: GrepToolResponse): void =>
					storeAndResolve(response, cache, cacheKey, (r) => settle(() => resolve(r)));
				if (cache && cacheKey) {
					const cachedResponse = withGrepCacheHit(cache.get(cacheKey));
					if (cachedResponse) {
						traceEvent("fs.grep.cache", { hit: true, searchPath });
						settle(() => resolve(cachedResponse));
						return;
					}
					traceEvent("fs.grep.cache", { hit: false, searchPath });
				}

				const canInProcess = !isDirectory && !glob && !fileType;
				if (canInProcess) {
					const response = await grepFileInProcess(
						{
							pattern,
							filePath: searchPath,
							displayName: path.basename(searchPath),
							ignoreCase,
							literal,
							context: contextValue,
							limit: effectiveLimit,
							filesWithMatches,
							countOnly,
						},
						ops,
					);
					resolveWithOptionalCache(response);
					return;
				}

				const rgPath = await resolveRgPath();
				if (!rgPath) {
					settle(() => reject(new Error("ripgrep (rg) is not available and could not be downloaded")));
					return;
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

				child.stderr.on("data", (chunk: Buffer | string) => {
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

				// eslint-disable-next-line @typescript-eslint/no-misused-promises -- Node.js EventEmitter does not await handlers
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
