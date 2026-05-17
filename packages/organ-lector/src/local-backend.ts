/**
 * LocalLectorBackend — the default backend for development and production.
 *
 * Backends:
 *   read/write/edit  — node:fs/promises
 *   symbols          — regex extractor (Phase 1); TreeSitter (Phase 2)
 *   search           — ripgrep (rg) with grep fallback
 *   find             — fd with node:fs/promises walk fallback
 *   callers          — grep-based (Phase 1); LSP callHierarchy (Phase 2)
 *
 * All reads go through BlockCache first. Writes and edits invalidate before
 * touching disk, so the cache is never stale when the call resolves.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import type {
	CallersOptions,
	CallSite,
	EditSpec,
	FindOptions,
	LectorBackend,
	ReadOptions,
	ReadResult,
	SearchMatch,
	SearchOptions,
} from "./backend.js";
import { BlockCache } from "./block-cache.js";
import { extractBlock, extractSymbols } from "./symbol-extractor.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

async function atomicWrite(dest: string, content: string): Promise<void> {
	const tmp = `${dest}.tmp.${randomUUID()}`;
	try {
		await writeFile(tmp, content, "utf-8");
		await rename(tmp, dest);
	} catch (err) {
		await unlink(tmp).catch(() => {});
		throw err;
	}
}

const DEFAULT_MAX_LINES_FULL = 2000;
const DEFAULT_MAX_LINES_BLOCK = 300;
const DEFAULT_MAX_RESULTS_SEARCH = 200;
const DEFAULT_MAX_RESULTS_FIND = 500;
const DEFAULT_MAX_RESULTS_CALLERS = 100;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolvePath(cwd: string, p: string, allowAbsolute = false): string {
	const abs = resolve(cwd, p);
	if (!allowAbsolute) {
		const normRoot = resolve(cwd);
		if (abs !== normRoot && !abs.startsWith(`${normRoot}/`)) {
			throw new Error(
				`Path '${p}' resolves outside workspace root '${normRoot}'. ` +
					"Use allowAbsolutePaths option to override.",
			);
		}
	}
	return abs;
}

function spawnCollect(
	cmd: string,
	args: string[],
	cwd: string,
	signal?: AbortSignal,
): Promise<{ stdout: string; exitCode: number }> {
	return new Promise((res) => {
		const proc = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		proc.stdout.on("data", (d: Buffer) => {
			stdout += d.toString();
		});
		proc.on("close", (code) => res({ stdout, exitCode: code ?? 1 }));
		signal?.addEventListener("abort", () => proc.kill());
	});
}

// ---------------------------------------------------------------------------
// LocalLectorBackend
// ---------------------------------------------------------------------------

export interface LocalLectorBackendOptions {
	/** Workspace root. All relative paths resolve against this. */
	cwd: string;
	/**
	 * Allow paths outside cwd. Default: false.
	 * Set true only for system-level agents that explicitly need cross-workspace access.
	 */
	allowAbsolutePaths?: boolean;
}

export class LocalLectorBackend implements LectorBackend {
	private readonly cwd: string;
	private readonly cache: BlockCache;
	private readonly allowAbsolutePaths: boolean;

	constructor(opts: LocalLectorBackendOptions) {
		this.cwd = opts.cwd;
		this.cache = new BlockCache();
		this.allowAbsolutePaths = opts.allowAbsolutePaths ?? false;
	}

	/** Expose cache for organ unmount cleanup. */
	get blockCache(): BlockCache {
		return this.cache;
	}

	// -------------------------------------------------------------------------
	// read
	// -------------------------------------------------------------------------

	async read(path: string, opts: ReadOptions = {}): Promise<ReadResult> {
		const abs = resolvePath(this.cwd, path, this.allowAbsolutePaths);

		// Serve from block cache if available.
		let cached = this.cache.get(abs);
		if (!cached) {
			const content = await readFile(abs, "utf-8");
			const symbols = extractSymbols(content);
			cached = { content, symbols, storedAt: process.hrtime.bigint() };
			this.cache.set(abs, cached);
		}

		const { content, symbols } = cached;
		const allLines = content.split("\n");
		const totalLines = allLines.length;

		// Symbol-block mode
		if (opts.symbol) {
			const block = extractBlock(content, symbols, opts.symbol);
			if (!block) throw new Error(`lector.read: symbol '${opts.symbol}' not found in ${path}`);

			const maxLines = opts.maxLines ?? DEFAULT_MAX_LINES_BLOCK;
			const blockLines = block.content.split("\n");
			const truncated = blockLines.length > maxLines;
			return {
				path,
				content: truncated ? blockLines.slice(0, maxLines).join("\n") : block.content,
				symbols,
				totalLines,
				truncated,
			};
		}

		// Full-file mode with optional offset/limit
		const maxLines = opts.maxLines ?? DEFAULT_MAX_LINES_FULL;
		const offset = opts.offset != null ? Math.max(0, opts.offset - 1) : 0;
		const sliced = allLines.slice(offset, offset + maxLines);
		const truncated = offset + maxLines < totalLines;

		return {
			path,
			content: sliced.join("\n"),
			symbols,
			totalLines,
			truncated,
		};
	}

	// -------------------------------------------------------------------------
	// write
	// -------------------------------------------------------------------------

	async write(path: string, content: string): Promise<void> {
		const abs = resolvePath(this.cwd, path, this.allowAbsolutePaths);
		// Invalidate BEFORE writing — coherence guarantee.
		this.cache.invalidate(abs);
		await mkdir(dirname(abs), { recursive: true });
		await atomicWrite(abs, content);
	}

	// -------------------------------------------------------------------------
	// edit
	// -------------------------------------------------------------------------

	async edit(path: string, edits: EditSpec[]): Promise<void> {
		const abs = resolvePath(this.cwd, path, this.allowAbsolutePaths);
		// Invalidate BEFORE reading current content — any concurrent read will re-fetch.
		this.cache.invalidate(abs);

		let content = await readFile(abs, "utf-8");
		for (const { oldText, newText } of edits) {
			if (!oldText) throw new Error("lector.edit: oldText must not be empty");
			const first = content.indexOf(oldText);
			if (first === -1) throw new Error(`lector.edit: oldText not found in ${path}`);
			const last = content.lastIndexOf(oldText);
			if (first !== last)
				throw new Error(`lector.edit: oldText matches multiple locations in ${path} — make it unique`);
			content = content.slice(0, first) + newText + content.slice(first + oldText.length);
		}

		await atomicWrite(abs, content);
	}

	// -------------------------------------------------------------------------
	// search
	// -------------------------------------------------------------------------

	async search(pattern: string, opts: SearchOptions = {}): Promise<SearchMatch[]> {
		const searchRoot = opts.path ? resolvePath(this.cwd, opts.path, this.allowAbsolutePaths) : this.cwd;
		const maxResults = opts.maxResults ?? DEFAULT_MAX_RESULTS_SEARCH;

		const args = ["-rn", "--color=never"];
		if (opts.caseInsensitive) args.push("-i");
		if (opts.extension) args.push(`--include=*.${opts.extension.replace(/^\./, "")}`);
		args.push("--", pattern, searchRoot);

		// Try ripgrep first, fall back to grep.
		for (const cmd of ["rg", "grep"]) {
			const isRg = cmd === "rg";
			const rgArgs = isRg
				? [
						"-n",
						"--color=never",
						"--no-heading",
						...(opts.caseInsensitive ? ["-i"] : []),
						...(opts.extension ? ["-g", `*.${opts.extension.replace(/^\./, "")}`] : []),
						"--",
						pattern,
						searchRoot,
					]
				: args;

			try {
				const { stdout, exitCode } = await spawnCollect(cmd, rgArgs, this.cwd);
				if (exitCode > 1) continue; // 1 = no matches (ok), >1 = error
				return this._parseGrepOutput(stdout, maxResults);
			} catch {}
		}

		return [];
	}

	private _parseGrepOutput(stdout: string, maxResults: number): SearchMatch[] {
		const matches: SearchMatch[] = [];
		for (const line of stdout.split("\n")) {
			if (matches.length >= maxResults) break;
			const m = line.match(/^(.+?):(\d+):(.*)/);
			if (!m) continue;
			matches.push({
				path: relative(this.cwd, m[1]) || m[1],
				line: Number.parseInt(m[2], 10),
				content: m[3],
			});
		}
		return matches;
	}

	// -------------------------------------------------------------------------
	// find
	// -------------------------------------------------------------------------

	async find(glob: string, opts: FindOptions = {}): Promise<string[]> {
		const searchRoot = opts.path ? resolvePath(this.cwd, opts.path, this.allowAbsolutePaths) : this.cwd;
		const maxResults = opts.maxResults ?? DEFAULT_MAX_RESULTS_FIND;
		const maxDepth = opts.depth ?? Number.POSITIVE_INFINITY;
		const includeHidden = opts.hidden ?? false;

		// Try fd first.
		try {
			const fdArgs = ["--type", "f", "--color=never", "--no-ignore-vcs"];
			if (!includeHidden) fdArgs.push("--no-hidden");
			if (opts.depth != null) fdArgs.push("--max-depth", String(opts.depth));
			fdArgs.push(glob, searchRoot);

			const { stdout, exitCode } = await spawnCollect("fd", fdArgs, this.cwd);
			if (exitCode <= 1) {
				return stdout
					.split("\n")
					.filter(Boolean)
					.slice(0, maxResults)
					.map((p) => relative(this.cwd, p) || p);
			}
		} catch {
			/* fall through */
		}

		// Fallback: recursive node:fs walk with simple glob matching.
		const results: string[] = [];
		await this._walk(searchRoot, glob, maxDepth, includeHidden, results, maxResults);
		return results.map((p) => relative(this.cwd, p) || p);
	}

	private async _walk(
		dir: string,
		glob: string,
		maxDepth: number,
		includeHidden: boolean,
		results: string[],
		maxResults: number,
		depth = 0,
	): Promise<void> {
		if (depth > maxDepth || results.length >= maxResults) return;

		let entries: string[];
		try {
			entries = await readdir(dir);
		} catch {
			return;
		}

		for (const entry of entries) {
			if (!includeHidden && entry.startsWith(".")) continue;
			const full = join(dir, entry);
			let s: Awaited<ReturnType<typeof stat>>;
			try {
				s = await stat(full);
			} catch {
				continue;
			}

			if (s.isDirectory()) {
				await this._walk(full, glob, maxDepth, includeHidden, results, maxResults, depth + 1);
			} else if (s.isFile() && matchGlob(glob, entry)) {
				results.push(full);
			}
		}
	}

	// -------------------------------------------------------------------------
	// callers  (Phase 1: grep-based)
	// -------------------------------------------------------------------------

	async callers(symbol: string, opts: CallersOptions = {}): Promise<CallSite[]> {
		const maxResults = opts.maxResults ?? DEFAULT_MAX_RESULTS_CALLERS;
		const matches = await this.search(symbol, {
			path: opts.path,
			maxResults: maxResults * 2, // over-fetch to filter self-declarations
		});

		// Filter out the declaration lines — they contain `function symbol` or `class symbol`.
		const DECL_RE = new RegExp(`\\b(?:function|class|interface|type|const|let|var)\\s+${escapeRegex(symbol)}\\b`);

		const callers: CallSite[] = [];
		for (const m of matches) {
			if (callers.length >= maxResults) break;
			if (DECL_RE.test(m.content)) continue;
			callers.push({ path: m.path, line: m.line, context: m.content.trim() });
		}
		return callers;
	}
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Minimal glob matching: supports * and ? wildcards. */
function matchGlob(pattern: string, name: string): boolean {
	const re = new RegExp(
		`^${pattern
			.replace(/[.+^${}()|[\]\\]/g, "\\$&")
			.replace(/\*/g, ".*")
			.replace(/\?/g, ".")}$`,
	);
	return re.test(name);
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
