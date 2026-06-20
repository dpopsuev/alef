/**
 * FsOrgan — filesystem organ.
 *
 * Motor events handled → Sense results:
 *   fs.read   — read a file with optional offset/limit
 *   fs.grep   — ripgrep content search
 *   fs.find   — fd file-find
 */

import type { Stats } from "node:fs";
import { readFile as fsReadFile, mkdir } from "node:fs/promises";
import { dirname, resolve as nodeResolve } from "node:path";
import type { Organ, OrganLogger, PortDefinition } from "@dpopsuev/alef-kernel";
import { defineOrgan, typedAction, withDisplay } from "@dpopsuev/alef-kernel";
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
import { runFormatter } from "./formatter.js";
import type { FsCacheScope, FsRuntime } from "./fs-runtime.js";
import { atomicWrite } from "./fs-utils.js";
import { applyOps, parsePatch, validateOps } from "./patch.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "./truncate.js";

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const FS_READ_TOOL = {
	name: "fs.read",
	description:
		"Read raw text from any file. Returns up to 2000 lines or 50KB; use offset/limit to paginate. Use format='hashline' for content-addressed line references (required before fs.hashline-edit).",
	inputSchema: z.object({
		path: z.string().min(1).describe("Path to the file (relative or absolute)"),
		offset: z.number().optional().describe("Line number to start reading from (1-indexed)"),
		limit: z.number().optional().describe("Maximum number of lines to read"),
		format: z
			.enum(["raw", "hashline"])
			.optional()
			.describe("Output format: raw (default) or hashline (line numbers + content hashes for editing)"),
	}),
};

const FS_GREP_TOOL = {
	name: "fs.grep",
	description:
		"Search file contents by regex or literal pattern using ripgrep. Returns matching lines with file paths and line numbers. To find callers of a specific symbol, use lector.callers instead.",
	inputSchema: z.object({
		pattern: z.string().min(1).describe("Search pattern (regex or literal string)"),
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
	description:
		"Find files by glob pattern. Use depth=1 to list a directory's immediate children (equivalent to ls). Returns file paths.",
	inputSchema: z.object({
		pattern: z.string().min(1).describe("Glob pattern, e.g. '*.ts'. Use '*' to list all."),
		path: z.string().optional().describe("Directory to search (default: cwd)"),
		limit: z.coerce.number().optional().describe(`Max results (default: ${DEFAULT_FIND_LIMIT})`),
		type: z.enum(["file", "directory", "symlink"]).optional().describe("Filter by entry type"),
		extension: z.string().optional().describe("Filter by extension, e.g. 'ts'"),
		depth: z.coerce.number().optional().describe("Max directory depth. depth=1 = immediate children."),
		hidden: z.boolean().optional().describe("Include hidden files (default: true)"),
	}),
};

const FS_PATCH_TOOL = {
	name: "fs.patch",
	description:
		"Apply a multi-file patch atomically. Can add, update, move, and delete files in one call. " +
		"Validation runs before any file is touched — if any operation fails, nothing is modified. " +
		"Format: *** Begin Patch / *** Add File: path / *** Update File: path / *** Delete File: path / *** Move File: src -> dst / *** End Patch",
	inputSchema: z.object({
		patch: z.string().min(1).describe("Patch block starting with '*** Begin Patch' and ending with '*** End Patch'"),
	}),
};

const FS_WRITE_TOOL = {
	name: "fs.write",
	description:
		"Write full content to a file, creating or overwriting it. For targeted in-place replacements, use fs.edit instead.",
	inputSchema: z.object({
		path: z.string().min(1).describe("Path to the file (relative or absolute)"),
		content: z.string().min(1).describe("Content to write"),
	}),
};

const EditEntrySchema = z.object({
	oldText: z.string().min(1).describe("Exact text to find (must be unique in the file)"),
	newText: z.string().min(1).describe("Replacement text"),
});

// Accept edits as a JSON array OR as a JSON-encoded string (LLMs sometimes
// serialize arrays as strings when the schema was not visible on the first turn).
const editsField = z
	.preprocess((v) => {
		if (typeof v === "string") {
			try {
				return JSON.parse(v) as unknown;
			} catch {
				return v;
			}
		}
		return v;
	}, z.array(EditEntrySchema).min(1))
	.describe("One or more replacements to apply atomically");

const FS_EDIT_TOOL = {
	name: "fs.edit",
	description:
		"Apply exact-text replacements to a file atomically. Requires reading the file first with fs.read. " +
		"Each oldText must be unique; overlapping edits are rejected. " +
		"For symbol-level replacement by function/class name, use lector.edit instead.",
	inputSchema: z.union([
		z.object({
			path: z.string().min(1).describe("Path to the file (relative or absolute)"),
			edits: editsField,
		}),
		z.object({
			path: z.string().min(1).describe("Path to the file (relative or absolute)"),
			oldText: z.string().min(1).describe("Exact text to find (must be unique in the file)"),
			newText: z.string().min(1).describe("Replacement text"),
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
	 * Directories the organ is allowed to access (OCAP grant).
	 * Injected by the materializer from config.security.writable_roots.
	 * Undefined = unrestricted (no guard). Empty or populated = enforce.
	 */
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
	/** Maximum number of paths retained. Oldest entries evicted when exceeded. */
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

function resolveFilePath(cwd: string, filePath: string): string {
	const abs = nodeResolve(cwd, filePath);
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
	ctx: { payload: { path: string; offset?: number; limit?: number; format?: string } },
	opts: FsOrganOptions,
	tracker: FileTracker,
): Promise<Record<string, unknown>> {
	const { path: filePath, offset, limit, format } = ctx.payload;
	if (!filePath) throw new Error("fs.read: path is required");

	const absolutePath = resolveFilePath(opts.cwd, filePath);

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

	if (format === "hashline") {
		const { formatHashline } = await import("./hashline.js");
		const hashlineContent = formatHashline(truncated.content, offset ?? 1);
		return {
			content: hashlineContent,
			truncated: truncated.truncated,
			truncatedBy: truncated.truncatedBy,
			totalLines: truncated.totalLines,
			outputLines: truncated.outputLines,
		};
	}

	return {
		content: truncated.content,
		truncated: truncated.truncated,
		truncatedBy: truncated.truncatedBy,
		totalLines: truncated.totalLines,
		outputLines: truncated.outputLines,
	};
}

async function handleWrite(
	ctx: { payload: { path: string; content: string } },
	opts: FsOrganOptions,
): Promise<Record<string, unknown>> {
	const { path: filePath, content } = ctx.payload;
	if (!filePath) throw new Error("fs.write: path is required");
	const absolutePath = resolveFilePath(opts.cwd, filePath);
	await mkdir(dirname(absolutePath), { recursive: true });
	await atomicWrite(absolutePath, content);
	await runFormatter(opts.cwd, absolutePath);
	const bytes = Buffer.byteLength(content, "utf-8");
	return { path: filePath, bytes };
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

type EditPayload =
	| { path: string; edits: Array<{ oldText: string; newText: string }> }
	| { path: string; oldText: string; newText: string };

async function handleEdit(
	ctx: { payload: EditPayload },
	opts: FsOrganOptions,
	tracker: FileTracker,
): Promise<Record<string, unknown>> {
	const { path: filePath } = ctx.payload;
	if (!filePath) throw new Error("fs.edit: path is required");

	// Normalise input: accept edits[] array OR single oldText/newText.
	type EditEntry = { oldText: string; newText: string };
	let editList: EditEntry[];
	if ("edits" in ctx.payload) {
		editList = ctx.payload.edits;
	} else {
		const { oldText, newText } = ctx.payload;
		if (!oldText) throw new Error("fs.edit: oldText is required");
		editList = [{ oldText, newText }];
	}

	const absolutePath = resolveFilePath(opts.cwd, filePath);

	// Existence check first — ENOENT surfaces before the tracker guard.
	let fileStat: Stats;
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
	await runFormatter(opts.cwd, absolutePath);
	// Refresh tracker so subsequent edits in the same turn don't fail staleness.
	tracker.record(absolutePath);
	const editCount = editList.length;
	const diff = generateEditDiff(original, updated, filePath);
	return { path: filePath, applied: true, editCount, diff };
}

async function handleGrep(
	ctx: {
		payload: {
			pattern: string;
			path?: string;
			glob?: string;
			ignoreCase?: boolean;
			literal?: boolean;
			context?: number;
			limit?: number;
			type?: string;
			filesWithMatches?: boolean;
			countOnly?: boolean;
		};
	},
	opts: FsOrganOptions,
): Promise<Record<string, unknown>> {
	const { pattern, path, glob, ignoreCase, literal, context, limit, type, filesWithMatches, countOnly } = ctx.payload;
	const input: GrepToolInput = {
		pattern,
		path,
		glob,
		ignoreCase: ignoreCase ?? false,
		literal: literal ?? false,
		context: context ?? 0,
		limit: limit ?? DEFAULT_GREP_LIMIT,
		type,
		filesWithMatches: filesWithMatches ?? false,
		countOnly: countOnly ?? false,
	};
	const response = await executeGrepQuery(input, { cwd: opts.cwd, cache: getCache(opts.runtime, "grep") });
	return response as unknown as Record<string, unknown>;
}

async function handleFind(
	ctx: {
		payload: {
			pattern: string;
			path?: string;
			limit?: number;
			type?: "file" | "directory" | "symlink";
			extension?: string;
			depth?: number;
			hidden?: boolean;
		};
	},
	opts: FsOrganOptions,
): Promise<Record<string, unknown>> {
	const { pattern, path, limit, type, extension, depth, hidden } = ctx.payload;
	const input: FindToolInput = {
		pattern,
		path,
		limit: limit ?? DEFAULT_FIND_LIMIT,
		type,
		extension,
		depth,
		hidden,
	};
	const response = await executeFindQuery(input, { cwd: opts.cwd, cache: getCache(opts.runtime, "find") });
	return response as unknown as Record<string, unknown>;
}

async function handlePatch(
	ctx: { payload: { patch: string } },
	opts: FsOrganOptions,
): Promise<Record<string, unknown>> {
	const { patch } = ctx.payload;
	const ops = parsePatch(patch);
	if (ops.length === 0) throw new Error("fs.patch: no operations found in patch block");

	const resolveAbs = (p: string) => resolveFilePath(opts.cwd, p);
	const errors = await validateOps(ops, resolveAbs);
	if (errors.length > 0) throw new Error(`fs.patch: validation failed:\n${errors.map((e) => `  ${e}`).join("\n")}`);

	const results = await applyOps(ops, resolveAbs, (abs) => runFormatter(opts.cwd, abs));
	const summary = results
		.map(
			(r) =>
				`${r.operation} ${r.path}${r.linesAdded || r.linesRemoved ? ` (+${r.linesAdded}/-${r.linesRemoved})` : ""}`,
		)
		.join("\n");
	return withDisplay({ results, fileCount: results.length }, { text: summary, mimeType: "text/plain" });
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
			motor: {
				"fs.read": typedAction(
					FS_READ_TOOL,
					async (ctx) => {
						const result = await handleRead(ctx, options, tracker);
						const truncated = result.truncated as boolean;
						const outputLines = result.outputLines as number | undefined;
						const totalLines = result.totalLines as number;
						const truncNote = truncated
							? ` (truncated to ${outputLines ?? "?"} / ${totalLines} lines)`
							: ` (${totalLines} lines)`;
						return withDisplay(result, {
							text: `Read **${ctx.payload.path}**${truncNote}`,
							mimeType: "text/plain",
						});
					},
					{ shouldCache: () => true },
				),
				"fs.grep": typedAction(
					FS_GREP_TOOL,
					async (ctx) => {
						const result = await handleGrep(ctx, options);
						const displayText = extractContentText(result) ?? JSON.stringify(result);
						return withDisplay(result, { text: displayText, mimeType: "text/plain" });
					},
					{ shouldCache: () => true },
				),
				"fs.find": typedAction(FS_FIND_TOOL, async (ctx) => {
					const result = await handleFind(ctx, options);
					const displayText = extractContentText(result) ?? JSON.stringify(result);
					return withDisplay(result, { text: displayText, mimeType: "text/plain" });
				}),
				"fs.write": typedAction(
					FS_WRITE_TOOL,
					async (ctx) => {
						const absolutePath = nodeResolve(options.cwd, ctx.payload.path);
						const raw = await withQueue(absolutePath, () => handleWrite(ctx, options));
						const filePath = raw.path as string;
						const bytes = raw.bytes as number;
						return withDisplay(
							{ path: filePath, bytes },
							{ text: `Wrote **${filePath}** (${bytes} bytes)`, mimeType: "text/plain" },
						);
					},
					{ invalidates: () => WRITE_INVALIDATES },
				),
				"fs.edit": typedAction(
					FS_EDIT_TOOL,
					async (ctx) => {
						const absolutePath = nodeResolve(options.cwd, ctx.payload.path);
						const result = await withQueue(absolutePath, () => handleEdit(ctx, options, tracker));
						return withDisplay(
							{ path: result.path, applied: result.applied, editCount: result.editCount },
							{ text: result.diff as string, mimeType: "text/x-diff" },
						);
					},
					{ invalidates: () => WRITE_INVALIDATES },
				),
				"fs.patch": typedAction(FS_PATCH_TOOL, (ctx) => handlePatch(ctx, options), {
					invalidates: () => WRITE_INVALIDATES,
				}),
			},
		},
		{
			actions: options.actions,
			directives: FS_DIRECTIVES,
			logger: options.logger,
			description: "Read, write, edit, search, and find files within the workspace.",
			labels: ["filesystem", "read", "write", "search"],
			contributions: {
				port: {
					name: "filesystem",
					eventPattern: "motor/fs.",
					cardinality: "zero-or-one",
				} satisfies PortDefinition,
			},
			publishSchemas: {
				sense: {
					"fs.read": z.object({
						content: z.string().min(1),
						truncated: z.boolean(),
						totalLines: z.number(),
					}),
					"fs.write": z.object({ path: z.string().min(1), bytes: z.number() }),
					"fs.edit": z.object({ path: z.string().min(1), applied: z.boolean() }),
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
- Use fs.patch when a refactor touches multiple files — one call, all-or-nothing validation before any file is written.
- All paths must be within the allowed roots configured by the security profile. Paths outside are rejected.`,
];
