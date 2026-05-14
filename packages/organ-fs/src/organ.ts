/**
 * FsCorpusOrgan — FilesystemOrgan as a CorpusOrgan.
 *
 * Subscribes Motor events for file operations, executes them, and publishes
 * Sense results back onto the nerve. Exposes tool definitions so the LLM can
 * invoke file operations through the standard tool-call pathway.
 *
 * Motor events handled:
 *   "fs.read"  — read a file with optional offset/limit
 *   "fs.grep"  — ripgrep search
 *   "fs.find"  — fd file-find
 *
 * Sense events published (correlationId mirrored from Motor):
 *   "fs.read"  — { content: string, truncated: boolean, ... }
 *   "fs.grep"  — { matches: ..., limitReached: boolean, ... }
 *   "fs.find"  — { entries: ..., limitReached: boolean, ... }
 */
import { readFile as fsReadFile } from "node:fs/promises";
import { isAbsolute, resolve as nodeResolve } from "node:path";
import type { CorpusNerve, CorpusOrgan, MotorEvent, SenseEvent, ToolDefinition } from "@dpopsuev/alef-spine";
import {
	DEFAULT_FIND_LIMIT,
	DEFAULT_GREP_LIMIT,
	executeFindQuery,
	executeGrepQuery,
	type FindToolInput,
	type GrepToolInput,
} from "./file-queries.js";
import type { FsCacheScope, FsRuntime } from "./fs-runtime.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "./truncate.js";

// ---------------------------------------------------------------------------
// Tool definitions (JSON Schema)
// ---------------------------------------------------------------------------

const FS_READ_TOOL: ToolDefinition = {
	name: "fs.read",
	description:
		"Read the contents of a file. Output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files.",
	inputSchema: {
		type: "object",
		properties: {
			path: { type: "string", description: "Path to the file to read (relative or absolute)" },
			offset: { type: "number", description: "Line number to start reading from (1-indexed)" },
			limit: { type: "number", description: "Maximum number of lines to read" },
		},
		required: ["path"],
	},
};

const FS_GREP_TOOL: ToolDefinition = {
	name: "fs.grep",
	description: "Search file contents using ripgrep. Returns matching lines with file paths and line numbers.",
	inputSchema: {
		type: "object",
		properties: {
			pattern: { type: "string", description: "Search pattern (regex or literal string)" },
			path: { type: "string", description: "Directory or file to search (default: current directory)" },
			glob: { type: "string", description: "Filter files by glob pattern, e.g. '*.ts'" },
			ignoreCase: { type: "boolean", description: "Case-insensitive search (default: false)" },
			literal: { type: "boolean", description: "Treat pattern as literal string instead of regex (default: false)" },
			context: { type: "number", description: "Number of lines to show before and after each match (default: 0)" },
			limit: { type: "number", description: `Maximum number of matches to return (default: ${DEFAULT_GREP_LIMIT})` },
			type: { type: "string", description: "Filter by file type, e.g. 'ts', 'go', 'py', 'js'" },
			filesWithMatches: {
				type: "boolean",
				description: "Return only file paths containing matches, no line content",
			},
			countOnly: { type: "boolean", description: "Return match count per file instead of content" },
		},
		required: ["pattern"],
	},
};

const FS_FIND_TOOL: ToolDefinition = {
	name: "fs.find",
	description:
		"Find files and directories using fd. Use depth=1 to list immediate children (replaces ls). Supports glob patterns, type filters, and extension filters.",
	inputSchema: {
		type: "object",
		properties: {
			pattern: {
				type: "string",
				description: "Glob pattern to match files, e.g. '*.ts', '**/*.json'. Use '*' to list all entries.",
			},
			path: { type: "string", description: "Directory to search in (default: current directory)" },
			limit: { type: "number", description: `Maximum number of results (default: ${DEFAULT_FIND_LIMIT})` },
			type: {
				type: "string",
				enum: ["file", "directory", "symlink"],
				description: "Filter by entry type",
			},
			extension: {
				type: "string",
				description: "Filter by file extension, e.g. 'ts' or '.ts'",
			},
			depth: {
				type: "number",
				description: "Maximum directory depth to descend. Use depth=1 to list only immediate children.",
			},
			hidden: {
				type: "boolean",
				description: "Include hidden files and directories (default: true)",
			},
		},
		required: ["pattern"],
	},
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export interface FsOrganOptions {
	/** Working directory for relative path resolution. */
	cwd: string;
	/** Optional runtime providing per-scope caches. */
	runtime?: FsRuntime;
}

function getCache(runtime: FsRuntime | undefined, scope: FsCacheScope) {
	return runtime?.getCache(scope);
}

function resolveFilePath(cwd: string, filePath: string): string {
	return isAbsolute(filePath) ? filePath : nodeResolve(cwd, filePath);
}

function makeSense(
	motor: MotorEvent,
	payload: Record<string, unknown>,
	isError = false,
	errorMessage?: string,
): SenseEvent {
	// Mirror toolCallId if present so LLMOrgan can correlate tool results.
	const toolCallId = typeof motor.payload.toolCallId === "string" ? motor.payload.toolCallId : undefined;
	return {
		type: motor.type,
		correlationId: motor.correlationId,
		timestamp: Date.now(),
		payload: toolCallId ? { ...payload, toolCallId } : payload,
		isError,
		errorMessage,
	};
}

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

async function handleRead(motor: MotorEvent, nerve: CorpusNerve, opts: FsOrganOptions): Promise<void> {
	const args = motor.payload;
	const filePath = String(args.path ?? "");
	const offset = typeof args.offset === "number" ? args.offset : undefined;
	const limit = typeof args.limit === "number" ? args.limit : undefined;

	try {
		const absolutePath = resolveFilePath(opts.cwd, filePath);
		const rawContent = await fsReadFile(absolutePath, "utf-8");
		// Apply offset: skip (offset - 1) lines (offset is 1-indexed)
		const contentToRead =
			offset && offset > 1
				? rawContent
						.split("\n")
						.slice(offset - 1)
						.join("\n")
				: rawContent;
		const truncated = truncateHead(contentToRead, {
			maxLines: limit ?? DEFAULT_MAX_LINES,
			maxBytes: DEFAULT_MAX_BYTES,
		});
		nerve.sense.publish(
			makeSense(motor, {
				content: truncated.content,
				truncated: truncated.truncated,
				truncatedBy: truncated.truncatedBy,
				totalLines: truncated.totalLines,
				outputLines: truncated.outputLines,
			}),
		);
	} catch (err) {
		nerve.sense.publish(makeSense(motor, { content: "" }, true, err instanceof Error ? err.message : String(err)));
	}
}

async function handleGrep(motor: MotorEvent, nerve: CorpusNerve, opts: FsOrganOptions): Promise<void> {
	const args = motor.payload;
	const input: GrepToolInput = {
		pattern: String(args.pattern ?? ""),
		path: args.path !== undefined ? String(args.path) : undefined,
		glob: args.glob !== undefined ? String(args.glob) : undefined,
		ignoreCase: Boolean(args.ignoreCase ?? false),
		literal: Boolean(args.literal ?? false),
		context: typeof args.context === "number" ? args.context : 0,
		limit: typeof args.limit === "number" ? args.limit : DEFAULT_GREP_LIMIT,
		type: args.type !== undefined ? String(args.type) : undefined,
		filesWithMatches: Boolean(args.filesWithMatches ?? false),
		countOnly: Boolean(args.countOnly ?? false),
	};
	try {
		const response = await executeGrepQuery(input, {
			cwd: opts.cwd,
			cache: getCache(opts.runtime, "grep"),
		});
		nerve.sense.publish(makeSense(motor, response as unknown as Record<string, unknown>));
	} catch (err) {
		nerve.sense.publish(makeSense(motor, {}, true, err instanceof Error ? err.message : String(err)));
	}
}

async function handleFind(motor: MotorEvent, nerve: CorpusNerve, opts: FsOrganOptions): Promise<void> {
	const args = motor.payload;
	const input: FindToolInput = {
		pattern: String(args.pattern ?? ""),
		path: args.path !== undefined ? String(args.path) : undefined,
		limit: typeof args.limit === "number" ? args.limit : DEFAULT_FIND_LIMIT,
		type: args.type === "file" || args.type === "directory" || args.type === "symlink" ? args.type : undefined,
		extension: args.extension !== undefined ? String(args.extension) : undefined,
		depth: typeof args.depth === "number" ? args.depth : undefined,
		hidden: args.hidden !== undefined ? Boolean(args.hidden) : undefined,
	};
	try {
		const response = await executeFindQuery(input, {
			cwd: opts.cwd,
			cache: getCache(opts.runtime, "find"),
		});
		nerve.sense.publish(makeSense(motor, response as unknown as Record<string, unknown>));
	} catch (err) {
		nerve.sense.publish(makeSense(motor, {}, true, err instanceof Error ? err.message : String(err)));
	}
}

// ---------------------------------------------------------------------------
// CorpusOrgan factory
// ---------------------------------------------------------------------------

/**
 * Create the filesystem organ as a CorpusOrgan.
 *
 * @example
 * ```typescript
 * import { createFsOrgan } from "@dpopsuev/alef-organ-fs";
 * import { Corpus } from "@dpopsuev/alef-corpus";
 *
 * const corpus = new Corpus();
 * corpus.load(createFsOrgan({ cwd: process.cwd() }));
 * ```
 */
export function createFsOrgan(options: FsOrganOptions): CorpusOrgan {
	return {
		kind: "corpus",
		name: "fs",
		tools: [FS_READ_TOOL, FS_GREP_TOOL, FS_FIND_TOOL],

		mount(nerve: CorpusNerve): () => void {
			const unsubRead = nerve.motor.subscribe("fs.read", (event) => handleRead(event, nerve, options));
			const unsubGrep = nerve.motor.subscribe("fs.grep", (event) => handleGrep(event, nerve, options));
			const unsubFind = nerve.motor.subscribe("fs.find", (event) => handleFind(event, nerve, options));

			return () => {
				unsubRead();
				unsubGrep();
				unsubFind();
			};
		},
	};
}
