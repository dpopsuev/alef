/**
 * FsOrgan — filesystem CorpusOrgan.
 *
 * Motor events handled → Sense results:
 *   fs.read   — read a file with optional offset/limit
 *   fs.grep   — ripgrep content search
 *   fs.find   — fd file-find
 */

import { randomUUID } from "node:crypto";
import { readFile as fsReadFile, rename as fsRename, writeFile as fsWriteFile, mkdir, unlink } from "node:fs/promises";
import { dirname, resolve as nodeResolve } from "node:path";
import type { CorpusHandlerCtx, Organ } from "@dpopsuev/alef-spine";
import { defineCorpusOrgan } from "@dpopsuev/alef-spine";
import { z } from "zod";
import {
	DEFAULT_FIND_LIMIT,
	DEFAULT_GREP_LIMIT,
	executeFindQuery,
	executeGrepQuery,
	type FindToolInput,
	type GrepToolInput,
} from "./file-queries.js";
import type { FsCacheScope, FsRuntime } from "./fs-runtime.js";
import { assertWithinRoot } from "./path-guard.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "./truncate.js";

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const FS_READ_TOOL = {
	name: "fs.read",
	description: "Read the contents of a file. Truncated to 2000 lines or 50KB. Use offset/limit for large files.",
	inputSchema: z.object({
		path: z.string().describe("Path to the file (relative or absolute)"),
		offset: z.number().optional().describe("Line number to start reading from (1-indexed)"),
		limit: z.number().optional().describe("Maximum number of lines to read"),
	}),
};

const FS_GREP_TOOL = {
	name: "fs.grep",
	description: "Search file contents using ripgrep. Returns matching lines with file paths and line numbers.",
	inputSchema: z.object({
		pattern: z.string().describe("Search pattern (regex or literal string)"),
		path: z.string().optional().describe("Directory or file to search (default: cwd)"),
		glob: z.string().optional().describe("Filter files by glob pattern, e.g. '*.ts'"),
		ignoreCase: z.boolean().optional().describe("Case-insensitive search (default: false)"),
		literal: z.boolean().optional().describe("Treat pattern as literal string (default: false)"),
		context: z.number().optional().describe("Lines before/after each match (default: 0)"),
		limit: z.number().optional().describe(`Max matches to return (default: ${DEFAULT_GREP_LIMIT})`),
		type: z.string().optional().describe("Filter by file type, e.g. 'ts', 'go', 'py'"),
		filesWithMatches: z.boolean().optional().describe("Return only file paths with matches"),
		countOnly: z.boolean().optional().describe("Return match count per file"),
	}),
};

const FS_FIND_TOOL = {
	name: "fs.find",
	description: "Find files using fd. depth=1 lists immediate children (replaces ls).",
	inputSchema: z.object({
		pattern: z.string().describe("Glob pattern, e.g. '*.ts'. Use '*' to list all."),
		path: z.string().optional().describe("Directory to search (default: cwd)"),
		limit: z.number().optional().describe(`Max results (default: ${DEFAULT_FIND_LIMIT})`),
		type: z.enum(["file", "directory", "symlink"]).optional().describe("Filter by entry type"),
		extension: z.string().optional().describe("Filter by extension, e.g. 'ts'"),
		depth: z.number().optional().describe("Max directory depth. depth=1 = immediate children."),
		hidden: z.boolean().optional().describe("Include hidden files (default: true)"),
	}),
};

const FS_WRITE_TOOL = {
	name: "fs.write",
	description: "Write content to a file. Creates the file if it doesn't exist, overwrites if it does.",
	inputSchema: z.object({
		path: z.string().describe("Path to the file (relative or absolute)"),
		content: z.string().describe("Content to write"),
	}),
};

const FS_EDIT_TOOL = {
	name: "fs.edit",
	description:
		"Replace the first exact occurrence of oldText with newText in a file. Throws if oldText is not found or is not unique.",
	inputSchema: z.object({
		path: z.string().describe("Path to the file (relative or absolute)"),
		oldText: z.string().describe("Exact text to find and replace"),
		newText: z.string().describe("Replacement text"),
	}),
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface FsOrganOptions {
	cwd: string;
	runtime?: FsRuntime;
	/** Allowlist of fs action names to mount (e.g. ['fs.read', 'fs.grep']). Default: all. */
	actions?: readonly string[];
	/**
	 * Allow paths outside cwd (e.g. absolute paths anywhere on disk).
	 * Default: false — all paths must resolve within cwd.
	 */
	allowAbsolutePaths?: boolean;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function getCache(runtime: FsRuntime | undefined, scope: FsCacheScope) {
	return runtime?.getCache(scope);
}

function resolveFilePath(cwd: string, filePath: string, allowAbsolute = false): string {
	const abs = nodeResolve(cwd, filePath);
	if (!allowAbsolute) {
		assertWithinRoot(abs, cwd);
	}
	return abs;
}

async function handleRead(ctx: CorpusHandlerCtx, opts: FsOrganOptions): Promise<Record<string, unknown>> {
	const filePath = String(ctx.payload.path ?? "");
	if (!filePath) throw new Error("fs.read: path is required");
	const offset = typeof ctx.payload.offset === "number" ? ctx.payload.offset : undefined;
	const limit = typeof ctx.payload.limit === "number" ? ctx.payload.limit : undefined;

	const absolutePath = resolveFilePath(opts.cwd, filePath, opts.allowAbsolutePaths);
	const rawContent = await fsReadFile(absolutePath, "utf-8");
	const contentToRead =
		offset && offset > 1
			? rawContent
					.split("\n")
					.slice(offset - 1)
					.join("\n")
			: rawContent;
	const truncated = truncateHead(contentToRead, { maxLines: limit ?? DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	return {
		content: truncated.content,
		truncated: truncated.truncated,
		truncatedBy: truncated.truncatedBy,
		totalLines: truncated.totalLines,
		outputLines: truncated.outputLines,
	};
}

async function atomicWrite(dest: string, content: string): Promise<void> {
	const tmp = `${dest}.tmp.${randomUUID()}`;
	try {
		await fsWriteFile(tmp, content, "utf-8");
		await fsRename(tmp, dest);
	} catch (err) {
		await unlink(tmp).catch(() => {});
		throw err;
	}
}

async function handleWrite(ctx: CorpusHandlerCtx, opts: FsOrganOptions): Promise<Record<string, unknown>> {
	const filePath = String(ctx.payload.path ?? "");
	if (!filePath) throw new Error("fs.write: path is required");
	const content = typeof ctx.payload.content === "string" ? ctx.payload.content : "";
	const absolutePath = resolveFilePath(opts.cwd, filePath, opts.allowAbsolutePaths);
	await mkdir(dirname(absolutePath), { recursive: true });
	await atomicWrite(absolutePath, content);
	return { path: filePath, bytes: Buffer.byteLength(content, "utf-8") };
}

async function handleEdit(ctx: CorpusHandlerCtx, opts: FsOrganOptions): Promise<Record<string, unknown>> {
	const filePath = String(ctx.payload.path ?? "");
	if (!filePath) throw new Error("fs.edit: path is required");
	const oldText = typeof ctx.payload.oldText === "string" ? ctx.payload.oldText : "";
	const newText = typeof ctx.payload.newText === "string" ? ctx.payload.newText : "";
	if (!oldText) throw new Error("fs.edit: oldText is required");

	const absolutePath = resolveFilePath(opts.cwd, filePath, opts.allowAbsolutePaths);
	const original = await fsReadFile(absolutePath, "utf-8");

	const firstIdx = original.indexOf(oldText);
	if (firstIdx === -1) throw new Error(`fs.edit: oldText not found in ${filePath}`);

	const lastIdx = original.lastIndexOf(oldText);
	if (lastIdx !== firstIdx)
		throw new Error(`fs.edit: oldText matches multiple locations in ${filePath} — make it unique`);

	const updated = original.slice(0, firstIdx) + newText + original.slice(firstIdx + oldText.length);
	await atomicWrite(absolutePath, updated);
	return { path: filePath, applied: true };
}

async function handleGrep(ctx: CorpusHandlerCtx, opts: FsOrganOptions): Promise<Record<string, unknown>> {
	const input: GrepToolInput = {
		pattern: String(ctx.payload.pattern ?? ""),
		path: ctx.payload.path !== undefined ? String(ctx.payload.path) : undefined,
		glob: ctx.payload.glob !== undefined ? String(ctx.payload.glob) : undefined,
		ignoreCase: Boolean(ctx.payload.ignoreCase ?? false),
		literal: Boolean(ctx.payload.literal ?? false),
		context: typeof ctx.payload.context === "number" ? ctx.payload.context : 0,
		limit: typeof ctx.payload.limit === "number" ? ctx.payload.limit : DEFAULT_GREP_LIMIT,
		type: ctx.payload.type !== undefined ? String(ctx.payload.type) : undefined,
		filesWithMatches: Boolean(ctx.payload.filesWithMatches ?? false),
		countOnly: Boolean(ctx.payload.countOnly ?? false),
	};
	const response = await executeGrepQuery(input, { cwd: opts.cwd, cache: getCache(opts.runtime, "grep") });
	return response as unknown as Record<string, unknown>;
}

async function handleFind(ctx: CorpusHandlerCtx, opts: FsOrganOptions): Promise<Record<string, unknown>> {
	const input: FindToolInput = {
		pattern: String(ctx.payload.pattern ?? ""),
		path: ctx.payload.path !== undefined ? String(ctx.payload.path) : undefined,
		limit: typeof ctx.payload.limit === "number" ? ctx.payload.limit : DEFAULT_FIND_LIMIT,
		type:
			ctx.payload.type === "file" || ctx.payload.type === "directory" || ctx.payload.type === "symlink"
				? ctx.payload.type
				: undefined,
		extension: ctx.payload.extension !== undefined ? String(ctx.payload.extension) : undefined,
		depth: typeof ctx.payload.depth === "number" ? ctx.payload.depth : undefined,
		hidden: ctx.payload.hidden !== undefined ? Boolean(ctx.payload.hidden) : undefined,
	};
	const response = await executeFindQuery(input, { cwd: opts.cwd, cache: getCache(opts.runtime, "find") });
	return response as unknown as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Cache-invalidation prefix list for all write-path actions. */
const WRITE_INVALIDATES = ["fs.read", "fs.grep"];

export function createFsOrgan(options: FsOrganOptions): Organ {
	return defineCorpusOrgan(
		"fs",
		{
			"fs.read": {
				tool: FS_READ_TOOL,
				handle: (ctx) => handleRead(ctx, options),
				shouldCache: () => true,
			},
			"fs.grep": {
				tool: FS_GREP_TOOL,
				handle: (ctx) => handleGrep(ctx, options),
				shouldCache: () => true,
			},
			"fs.find": { tool: FS_FIND_TOOL, handle: (ctx) => handleFind(ctx, options) },
			"fs.write": {
				tool: FS_WRITE_TOOL,
				handle: (ctx) => handleWrite(ctx, options),
				invalidates: () => WRITE_INVALIDATES,
			},
			"fs.edit": {
				tool: FS_EDIT_TOOL,
				handle: (ctx) => handleEdit(ctx, options),
				invalidates: () => WRITE_INVALIDATES,
			},
		},
		{
			actions: options.actions,
			directives: FS_DIRECTIVES,
		},
	);
}

const FS_DIRECTIVES = [
	`**fs (filesystem) tool guidance**
- Always read a file with fs.read before editing it. Never guess its contents.
- Use fs.edit for targeted changes to existing files. Provide oldText that is unique within the file.
- Use fs.write only when creating a new file or completely rewriting one. It overwrites without warning.
- Use fs.grep to search file contents across the workspace before assuming something doesn't exist.
- Use fs.find to discover file paths when you don't know the exact name.
- All paths must be within the working directory. Absolute paths outside the workspace are rejected.`,
];
