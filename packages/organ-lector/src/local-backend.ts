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
import { pathToFileURL } from "node:url";
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
	SymbolBlock,
} from "./backend.js";
import { BlockCache } from "./block-cache.js";
import { LspClient } from "./lsp-client.js";
import { extractBlock, extractSymbols } from "./symbol-extractor.js";
import { extractSymbolsTs, isTsFile } from "./ts-symbol-extractor.js";

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

/**
 * Symbol-span edit with Optimistic Lock.
 *
 * Uses the cached symbol map (from the last lector.read) to locate the symbol's
 * span. Replaces lines [startLine, endLine] with newBody.
 *
 * Optimistic Lock: verifies the span content hasn't changed since the cache
 * was populated. Throws if the symbol is absent from the cache (stale read)
 * so the caller knows to re-read first.
 */
function applySymbolEdit(
	content: string,
	symbolName: string,
	newBody: string,
	path: string,
	cachedSymbols: SymbolBlock[] | undefined,
): string {
	if (!cachedSymbols || cachedSymbols.length === 0) {
		throw new Error(`lector.edit: no cached symbol map for '${path}'. Call lector.read first.`);
	}

	const sym = cachedSymbols.find((s) => s.name === symbolName);
	if (!sym) {
		throw new Error(
			`lector.edit: symbol '${symbolName}' not found in cached map for '${path}'.` +
				` Available: ${cachedSymbols.map((s) => s.name).join(", ")}`,
		);
	}

	const lines = content.split("\n");
	const startIdx = sym.startLine - 1; // 0-indexed
	const endIdx = sym.endLine - 1;

	if (startIdx < 0 || endIdx >= lines.length) {
		throw new Error(
			`lector.edit: symbol '${symbolName}' span [${sym.startLine}-${sym.endLine}] ` +
				`out of bounds for '${path}' (${lines.length} lines). File may have changed — re-read.`,
		);
	}

	// Replace the span with newBody.
	const before = lines.slice(0, startIdx);
	const after = lines.slice(endIdx + 1);
	return [...before, newBody, ...after].join("\n");
}

export class LocalLectorBackend implements LectorBackend {
	private readonly cwd: string;
	private readonly cache: BlockCache;
	private readonly allowAbsolutePaths: boolean;
	/** LSP client — lazy-started on first callers() call for a TS file. */
	private lsp: LspClient | null = null;
	private lspStarting: Promise<LspClient> | null = null;

	constructor(opts: LocalLectorBackendOptions) {
		this.cwd = opts.cwd;
		this.cache = new BlockCache();
		this.allowAbsolutePaths = opts.allowAbsolutePaths ?? false;
	}

	/** Expose cache for organ unmount cleanup. */
	get blockCache(): BlockCache {
		return this.cache;
	}

	/** Stop the LSP server if one was started. Called on organ unmount. */
	async stopLsp(): Promise<void> {
		const lsp = this.lsp;
		this.lsp = null;
		this.lspStarting = null;
		await lsp?.stop();
	}

	private async getLsp(): Promise<LspClient> {
		if (this.lsp) return this.lsp;
		if (!this.lspStarting) {
			this.lspStarting = LspClient.start(this.cwd)
				.then((c) => {
					this.lsp = c;
					return c;
				})
				.catch((e) => {
					this.lspStarting = null;
					throw e;
				});
		}
		return this.lspStarting;
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
			// Use TypeScript compiler API for .ts/.tsx (Phase 2 accuracy).
			// Fall back to regex extractor for other languages.
			const symbols = isTsFile(path) ? extractSymbolsTs(content, path) : extractSymbols(content);
			cached = { content, symbols, storedAt: process.hrtime.bigint() };
			this.cache.set(abs, cached);

			// Racer (Phase 4): pre-warm LSP in the background for TS files.
			// lector.read() returns compiler API symbols immediately (fast).
			// LSP indexes asynchronously so callers() gets exact results on
			// the next call without blocking the current read.
			if (isTsFile(path)) {
				void this.getLsp()
					.then((lsp) => lsp.openFile(pathToFileURL(abs).href, content))
					.catch(() => {}); // LSP optional — never block read
			}
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

		// Snapshot the cached symbol map BEFORE invalidation (Optimistic Lock).
		// Symbol-span edits verify the span against this snapshot.
		const cachedEntry = this.cache.get(abs);

		// Invalidate BEFORE reading current content.
		this.cache.invalidate(abs);

		let content = await readFile(abs, "utf-8");

		for (const { oldText, newText, symbol } of edits) {
			if (symbol) {
				// Symbol-span edit — replace the entire named symbol's span.
				content = applySymbolEdit(content, symbol, newText, path, cachedEntry?.symbols);
			} else {
				if (!oldText) throw new Error("lector.edit: provide oldText or symbol");
				const first = content.indexOf(oldText);
				if (first === -1) throw new Error(`lector.edit: oldText not found in ${path}`);
				const last = content.lastIndexOf(oldText);
				if (first !== last)
					throw new Error(`lector.edit: oldText matches multiple locations in ${path} — make it unique`);
				content = content.slice(0, first) + newText + content.slice(first + oldText.length);
			}
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
	// callers  (Phase 1: grep-based; Phase 2: LSP callHierarchy for TS files)
	// -------------------------------------------------------------------------

	async callers(symbol: string, opts: CallersOptions = {}): Promise<CallSite[]> {
		const maxResults = opts.maxResults ?? DEFAULT_MAX_RESULTS_CALLERS;

		// Phase 2: LSP callHierarchy for TypeScript files.
		// Requires the symbol to be found in a TS file via the cached symbol map.
		if (opts.path && isTsFile(opts.path)) {
			try {
				return await this._callersViaLsp(symbol, opts.path, maxResults);
			} catch {
				// LSP not available or failed — fall through to grep
			}
		}

		// Phase 1: grep-based fallback.
		return this._callersViaGrep(symbol, opts, maxResults);
	}

	private async _callersViaLsp(symbol: string, filePath: string, maxResults: number): Promise<CallSite[]> {
		const abs = resolvePath(this.cwd, filePath, this.allowAbsolutePaths);
		const { readFile: rf } = await import("node:fs/promises");
		const content = await rf(abs, "utf-8");
		const fileUrl = pathToFileURL(abs).href;

		// Find the symbol's position from the cached symbol map (or re-extract).
		const symbols = isTsFile(filePath) ? extractSymbolsTs(content, filePath) : extractSymbols(content);
		const sym = symbols.find((s) => s.name === symbol);
		if (!sym) throw new Error(`LSP callers: symbol '${symbol}' not found in ${filePath}`);

		const lsp = await this.getLsp();
		await lsp.openFile(fileUrl, content);

		// Use the start of the symbol's declaration line, column 0.
		return lsp.incomingCalls(fileUrl, sym.startLine - 1, 0, maxResults);
	}

	private async _callersViaGrep(symbol: string, opts: CallersOptions, maxResults: number): Promise<CallSite[]> {
		const matches = await this.search(symbol, {
			path: opts.path,
			maxResults: maxResults * 2,
		});
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
