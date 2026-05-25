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
import type { CorpusHandlerCtx, Organ, OrganLogger } from "@dpopsuev/alef-spine";
import { defineOrgan, getBoolean, getNumber, getString, withDisplay } from "@dpopsuev/alef-spine";
import { diffLines } from "diff";
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

const EditEntrySchema = z.object({
	oldText: z.string().describe("Exact text to find (must be unique in the file)"),
	newText: z.string().describe("Replacement text"),
});

const FS_EDIT_TOOL = {
	name: "fs.edit",
	description:
		"Edit a file by replacing exact text. Pass edits[] for multiple replacements in one atomic call. " +
		"Each oldText must be unique in the file. All edits are matched against the original — not incrementally. " +
		"Overlapping edits are rejected. Throws if any oldText is not found or not unique.",
	inputSchema: z.union([
		z.object({
			path: z.string().describe("Path to the file (relative or absolute)"),
			edits: z.array(EditEntrySchema).min(1).describe("One or more replacements to apply atomically"),
		}),
		z.object({
			path: z.string().describe("Path to the file (relative or absolute)"),
			oldText: z.string().describe("Exact text to find (must be unique in the file)"),
			newText: z.string().describe("Replacement text"),
		}),
	]),
};

// ---------------------------------------------------------------------------
// Per-path write serialization queue
//
// Concurrent fs.write / fs.edit calls on the same path chain onto a single
// promise so each operation sees the committed result of the previous one.
// The queue is per-organ-instance (not global) and cleans up resolved entries.
// ---------------------------------------------------------------------------

function makeWriteQueue() {
	const queues = new Map<string, Promise<void>>();

	return async function withQueue<T>(absolutePath: string, fn: () => Promise<T>): Promise<T> {
		const prev = queues.get(absolutePath) ?? Promise.resolve();
		let resolve!: () => void;
		const gate = new Promise<void>((res) => {
			resolve = res;
		});
		queues.set(absolutePath, gate);
		try {
			await prev;
			return await fn();
		} finally {
			resolve();
			// Clean up resolved entry so the Map does not grow unbounded.
			if (queues.get(absolutePath) === gate) queues.delete(absolutePath);
		}
	};
}

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
	/** Pino-compatible logger. Passed to defineOrgan for Orange/Yellow ROGYB output. */
	logger?: OrganLogger;
}

// ---------------------------------------------------------------------------
// FileTracker
//
// Records when each file was last read by fs.read.
// fs.edit enforces two guards before applying changes:
//   1. Read-before-edit: reject if the file has never been read this session.
//   2. Staleness: reject if the file mtime is newer than lastReadAt.
//
// In-memory per organ instance (one alef process = one instance = one session).
// Mirrors Crush's filetracker.Service pattern (internal/filetracker/service.go).
// ---------------------------------------------------------------------------

/** Exported for testing. Tracks per-path last-read timestamps to enforce read-before-edit. */
export class FileTracker {
	/** Maximum number of paths retained. Oldest entries evicted when exceeded (ALE-BUG-17). */
	static readonly MAX_SIZE = 1_000;

	private readonly reads = new Map<string, number>(); // absolutePath → Date.now()

	record(absolutePath: string): void {
		// Delete before re-insert to refresh insertion order (Map is insertion-ordered).
		this.reads.delete(absolutePath);
		this.reads.set(absolutePath, Date.now());
		// Evict oldest entries when cap is exceeded.
		if (this.reads.size > FileTracker.MAX_SIZE) {
			const oldest = this.reads.keys().next().value;
			if (oldest !== undefined) this.reads.delete(oldest);
		}
	}

	lastReadAt(absolutePath: string): number | undefined {
		return this.reads.get(absolutePath);
	}

	/** Number of tracked paths (for testing). */
	get size(): number {
		return this.reads.size;
	}
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** Extract text from file-query responses shaped { content: [{ type, text }] }. */
function extractContentText(response: unknown): string | undefined {
	if (response === null || typeof response !== "object") return undefined;
	const { content } = response as { content?: unknown };
	if (!Array.isArray(content) || content.length === 0) return undefined;
	const first = content[0] as { type?: string; text?: string };
	return typeof first.text === "string" ? first.text : undefined;
}

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

// Detect image/binary files by magic bytes. Returns the MIME type string or
// null when the file appears to be text.
function detectBinaryMime(buf: Buffer): string | null {
	if (buf.length < 4) return null;
	const b = buf;
	if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
	if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
	if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
	if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57) return "image/webp";
	if (b[0] === 0x42 && b[1] === 0x4d) return "image/bmp";
	if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return "application/pdf";
	// Null-byte heuristic: text files don't contain null bytes.
	const slice = b.slice(0, Math.min(512, b.length));
	for (let i = 0; i < slice.length; i++) {
		if (slice[i] === 0) return "application/octet-stream";
	}
	return null;
}

async function handleRead(
	ctx: CorpusHandlerCtx,
	opts: FsOrganOptions,
	tracker: FileTracker,
): Promise<Record<string, unknown>> {
	const filePath = getString(ctx.payload, "path") ?? "";
	if (!filePath) throw new Error("fs.read: path is required");
	const offset = getNumber(ctx.payload, "offset");
	const limit = getNumber(ctx.payload, "limit");

	const absolutePath = resolveFilePath(opts.cwd, filePath, opts.allowAbsolutePaths);

	// Read as buffer first to detect binary/image files by magic bytes.
	const rawBuf = await fsReadFile(absolutePath);
	const mimeType = detectBinaryMime(rawBuf);
	if (mimeType !== null) {
		throw new Error(
			`fs.read: '${filePath}' is a binary file (detected: ${mimeType}). ` +
				`Use a dedicated tool to handle binary content.`,
		);
	}

	const rawContent = rawBuf.toString("utf-8");
	const contentToRead =
		offset && offset > 1
			? rawContent
					.split("\n")
					.slice(offset - 1)
					.join("\n")
			: rawContent;
	const truncated = truncateHead(contentToRead, { maxLines: limit ?? DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	// Record that this file was read — enables read-before-edit enforcement.
	tracker.record(absolutePath);

	const truncNote = truncated.truncated
		? ` (truncated to ${truncated.outputLines ?? "?"} / ${truncated.totalLines} lines)`
		: ` (${truncated.totalLines} lines)`;
	return withDisplay(
		{
			content: truncated.content,
			truncated: truncated.truncated,
			truncatedBy: truncated.truncatedBy,
			totalLines: truncated.totalLines,
			outputLines: truncated.outputLines,
		},
		{ text: `Read **${filePath}**${truncNote}`, mimeType: "text/plain" },
	);
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
	const filePath = getString(ctx.payload, "path") ?? "";
	if (!filePath) throw new Error("fs.write: path is required");
	const content = getString(ctx.payload, "content") ?? "";
	const absolutePath = resolveFilePath(opts.cwd, filePath, opts.allowAbsolutePaths);
	await mkdir(dirname(absolutePath), { recursive: true });
	await atomicWrite(absolutePath, content);
	const bytes = Buffer.byteLength(content, "utf-8");
	return withDisplay(
		{ path: filePath, bytes },
		{ text: `Wrote **${filePath}** (${bytes} bytes)`, mimeType: "text/plain" },
	);
}

/**
 * Generate a compact unified diff suitable for TUI display.
 * Format mirrors pi's edit-diff.ts output: `+N line` / `-N line` / ` N ...`
 * with 4 lines of context around each changed region.
 */
function generateEditDiff(oldContent: string, newContent: string, filePath: string): string {
	const CONTEXT = 4;
	const parts = diffLines(oldContent, newContent);
	const maxLineNum = Math.max(oldContent.split("\n").length, newContent.split("\n").length);
	const w = String(maxLineNum).length;
	const out: string[] = [`edit ${filePath}`, ""];

	let oldLine = 1;
	let newLine = 1;

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		const raw = part.value.split("\n");
		if (raw[raw.length - 1] === "") raw.pop();

		if (part.added || part.removed) {
			for (const line of raw) {
				if (part.added) {
					out.push(`+${String(newLine).padStart(w)} ${line}`);
					newLine++;
				} else {
					out.push(`-${String(oldLine).padStart(w)} ${line}`);
					oldLine++;
				}
			}
		} else {
			const prevChange = i > 0 && (parts[i - 1]?.added || parts[i - 1]?.removed);
			const nextChange = i < parts.length - 1 && (parts[i + 1]?.added || parts[i + 1]?.removed);
			if (!prevChange && !nextChange) {
				oldLine += raw.length;
				newLine += raw.length;
				continue;
			}
			const leading = prevChange ? Math.min(CONTEXT, raw.length) : 0;
			const trailing = nextChange ? Math.min(CONTEXT, raw.length - leading) : 0;
			const skipped = raw.length - leading - trailing;
			for (let j = 0; j < leading; j++) {
				out.push(` ${String(oldLine).padStart(w)} ${raw[j]}`);
				oldLine++;
				newLine++;
			}
			if (skipped > 0) {
				out.push(` ${" ".repeat(w)} ...`);
				oldLine += skipped;
				newLine += skipped;
			}
			for (let j = raw.length - trailing; j < raw.length; j++) {
				out.push(` ${String(oldLine).padStart(w)} ${raw[j]}`);
				oldLine++;
				newLine++;
			}
		}
	}
	return out.join("\n");
}

async function handleEdit(
	ctx: CorpusHandlerCtx,
	opts: FsOrganOptions,
	tracker: FileTracker,
): Promise<Record<string, unknown>> {
	const filePath = getString(ctx.payload, "path") ?? "";
	if (!filePath) throw new Error("fs.edit: path is required");

	// Normalise input: accept edits[] array OR single oldText/newText.
	type EditEntry = { oldText: string; newText: string };
	let editList: EditEntry[];
	const rawEdits = ctx.payload.edits;
	if (Array.isArray(rawEdits) && rawEdits.length > 0) {
		editList = rawEdits as EditEntry[];
	} else {
		const oldText = getString(ctx.payload, "oldText") ?? "";
		const newText = getString(ctx.payload, "newText") ?? "";
		if (!oldText) throw new Error("fs.edit: oldText is required");
		editList = [{ oldText, newText }];
	}

	const absolutePath = resolveFilePath(opts.cwd, filePath, opts.allowAbsolutePaths);

	// Existence check first — ENOENT surfaces before the tracker guard.
	let fileStat: import("node:fs").Stats;
	try {
		fileStat = await import("node:fs/promises").then((m) => m.stat(absolutePath));
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") throw new Error(`fs.edit: file not found: ${filePath}`);
		if (code === "EACCES") throw new Error(`fs.edit: permission denied: ${filePath}`);
		throw err;
	}

	// FileTracker: guard 1 — read-before-edit.
	const lastReadAt = tracker.lastReadAt(absolutePath);
	if (lastReadAt === undefined) {
		throw new Error(
			`fs.edit: '${filePath}' has not been read this session. ` +
				`Use fs.read first so you can see the current content before editing.`,
		);
	}

	// FileTracker: guard 2 — staleness check.
	const mtimeMs = fileStat.mtimeMs;
	if (mtimeMs > lastReadAt) {
		const readStr = new Date(lastReadAt).toISOString();
		const modStr = new Date(mtimeMs).toISOString();
		throw new Error(
			`fs.edit: '${filePath}' was modified after you last read it ` +
				`(last read: ${readStr}, file mtime: ${modStr}). ` +
				`Re-read the file with fs.read before editing.`,
		);
	}

	let original: string;
	try {
		original = await fsReadFile(absolutePath, "utf-8");
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") throw new Error(`fs.edit: file not found: ${filePath}`);
		if (code === "EACCES") throw new Error(`fs.edit: permission denied: ${filePath}`);
		throw err;
	}

	// Locate each edit in the original (not incrementally).
	type LocatedEdit = { start: number; end: number; newText: string };
	const located: LocatedEdit[] = [];
	for (const { oldText, newText } of editList) {
		const firstIdx = original.indexOf(oldText);
		if (firstIdx === -1)
			throw new Error(`fs.edit: oldText not found in ${filePath}: ${JSON.stringify(oldText.slice(0, 40))}`);
		const lastIdx = original.lastIndexOf(oldText);
		if (lastIdx !== firstIdx)
			throw new Error(`fs.edit: oldText matches multiple locations in ${filePath} — make it unique`);
		located.push({ start: firstIdx, end: firstIdx + oldText.length, newText });
	}

	// Detect overlaps between edit ranges.
	const sorted = [...located].sort((a, b) => a.start - b.start);
	for (let i = 1; i < sorted.length; i++) {
		if ((sorted[i]?.start ?? 0) < (sorted[i - 1]?.end ?? 0)) {
			throw new Error(`fs.edit: edits overlap — check that edit regions do not intersect`);
		}
	}

	// Apply all edits in reverse order to preserve indices.
	let updated = original;
	for (const { start, end, newText } of [...sorted].reverse()) {
		updated = updated.slice(0, start) + newText + updated.slice(end);
	}

	await atomicWrite(absolutePath, updated);
	// Refresh tracker so subsequent edits in the same turn don't fail staleness.
	tracker.record(absolutePath);
	const editCount = editList.length;
	const diff = generateEditDiff(original, updated, filePath);
	return withDisplay({ path: filePath, applied: true, editCount }, { text: diff, mimeType: "text/x-diff" });
}

async function handleGrep(ctx: CorpusHandlerCtx, opts: FsOrganOptions): Promise<Record<string, unknown>> {
	const input: GrepToolInput = {
		pattern: getString(ctx.payload, "pattern") ?? "",
		path: getString(ctx.payload, "path"),
		glob: getString(ctx.payload, "glob"),
		ignoreCase: getBoolean(ctx.payload, "ignoreCase") ?? false,
		literal: getBoolean(ctx.payload, "literal") ?? false,
		context: getNumber(ctx.payload, "context") ?? 0,
		limit: getNumber(ctx.payload, "limit") ?? DEFAULT_GREP_LIMIT,
		type: getString(ctx.payload, "type"),
		filesWithMatches: getBoolean(ctx.payload, "filesWithMatches") ?? false,
		countOnly: getBoolean(ctx.payload, "countOnly") ?? false,
	};
	const response = await executeGrepQuery(input, { cwd: opts.cwd, cache: getCache(opts.runtime, "grep") });
	const displayText = extractContentText(response) ?? JSON.stringify(response);
	return withDisplay(response as unknown as Record<string, unknown>, { text: displayText, mimeType: "text/plain" });
}

async function handleFind(ctx: CorpusHandlerCtx, opts: FsOrganOptions): Promise<Record<string, unknown>> {
	const rawType = getString(ctx.payload, "type");
	const input: FindToolInput = {
		pattern: getString(ctx.payload, "pattern") ?? "",
		path: getString(ctx.payload, "path"),
		limit: getNumber(ctx.payload, "limit") ?? DEFAULT_FIND_LIMIT,
		type: rawType === "file" || rawType === "directory" || rawType === "symlink" ? rawType : undefined,
		extension: getString(ctx.payload, "extension"),
		depth: getNumber(ctx.payload, "depth"),
		hidden: getBoolean(ctx.payload, "hidden"),
	};
	const response = await executeFindQuery(input, { cwd: opts.cwd, cache: getCache(opts.runtime, "find") });
	const displayText = extractContentText(response) ?? JSON.stringify(response);
	return withDisplay(response as unknown as Record<string, unknown>, { text: displayText, mimeType: "text/plain" });
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Cache-invalidation prefix list for all write-path actions. */
const WRITE_INVALIDATES = ["fs.read", "fs.grep"];

export function createFsOrgan(options: FsOrganOptions): Organ {
	const withQueue = makeWriteQueue();
	const tracker = new FileTracker();

	return defineOrgan(
		"fs",
		{
			"motor/fs.read": {
				tool: FS_READ_TOOL,
				handle: (ctx: CorpusHandlerCtx) => handleRead(ctx, options, tracker),
				shouldCache: () => true,
			},
			"motor/fs.grep": {
				tool: FS_GREP_TOOL,
				handle: (ctx: CorpusHandlerCtx) => handleGrep(ctx, options),
				shouldCache: () => true,
			},
			"motor/fs.find": { tool: FS_FIND_TOOL, handle: (ctx: CorpusHandlerCtx) => handleFind(ctx, options) },
			"motor/fs.write": {
				tool: FS_WRITE_TOOL,
				handle: (ctx: CorpusHandlerCtx) => {
					const filePath = getString(ctx.payload, "path") ?? "";
					const absolutePath = nodeResolve(options.cwd, filePath);
					return withQueue(absolutePath, () => handleWrite(ctx, options));
				},
				invalidates: () => WRITE_INVALIDATES,
			},
			"motor/fs.edit": {
				tool: FS_EDIT_TOOL,
				handle: (ctx: CorpusHandlerCtx) => {
					const filePath = getString(ctx.payload, "path") ?? "";
					const absolutePath = nodeResolve(options.cwd, filePath);
					return withQueue(absolutePath, () => handleEdit(ctx, options, tracker));
				},
				invalidates: () => WRITE_INVALIDATES,
			},
		},
		{
			actions: options.actions,
			directives: FS_DIRECTIVES,
			logger: options.logger,
			description: "Read, write, edit, search, and find files within the workspace.",
			labels: ["filesystem", "read", "write", "search"],
			publishSchemas: {
				sense: {
					"fs.read": z.object({
						content: z.string(),
						truncated: z.boolean(),
						totalLines: z.number(),
					}),
					"fs.write": z.object({ path: z.string(), bytes: z.number() }),
					"fs.edit": z.object({ path: z.string(), applied: z.boolean() }),
				},
			},
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
