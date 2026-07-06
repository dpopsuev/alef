/**
 * LocalCodeIntelBackend — LSP-based code intelligence for TypeScript/JavaScript.
 *
 * Provides:
 *   callers          — LSP callHierarchy (TS files) + grep fallback
 *   diagnostics      — LSP textDocument/diagnostic
 *   hover            — LSP textDocument/hover
 *   workspaceSymbols — LSP workspace/symbol
 *
 * Design: Pure LSP wrapper. No file I/O operations (use fs adapter for that).
 */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { traceEvent } from "@dpopsuev/alef-kernel/log";
import type { CallersOptions, CallSite, CodeIntelBackend } from "./backend.js";
import { LspClient } from "./lsp-client.js";
import { extractSymbolsFor } from "./symbol-strategies.js";
import { isTsFile } from "./ts-symbol-extractor.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 *
 */
function isWithin(normAbs: string, normRoot: string): boolean {
	return normAbs === normRoot || normAbs.startsWith(`${normRoot}/`);
}

/**
 *
 */
function resolvePath(cwd: string, p: string, writableRoots?: readonly string[]): string {
	const abs = resolve(cwd, p);
	if (writableRoots) {
		const allowed = writableRoots.some((root) => isWithin(resolve(abs), resolve(root)));
		if (!allowed) {
			const rootList = writableRoots.map((r) => `'${resolve(r)}'`).join(", ");
			throw new Error(`Path '${p}' resolves outside the allowed roots [${rootList}].`);
		}
	}
	return abs;
}

/**
 *
 */
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
// LocalCodeIntelBackend
// ---------------------------------------------------------------------------

/**
 *
 */
export interface LocalCodeIntelBackendOptions {
	/** Workspace root. All relative paths resolve against this. */
	cwd: string;
	/**
	 * Directories the adapter is allowed to access (OCAP grant).
	 * Undefined = unrestricted (no guard). Populated = enforce.
	 */
	writableRoots?: readonly string[];
}

interface CallersStrategy {
	canHandle(opts: CallersOptions): boolean;
	resolve(
		backend: LocalCodeIntelBackend,
		symbol: string,
		opts: CallersOptions,
		maxResults: number,
	): Promise<CallSite[]>;
}

const DEFAULT_MAX_RESULTS_CALLERS = 100;
const DEFAULT_MAX_RESULTS_SEARCH = 200;

/**
 *
 */
export class LocalCodeIntelBackend implements CodeIntelBackend {
	private readonly cwd: string;
	private readonly writableRoots: readonly string[] | undefined;
	/** LSP client — lazy-started on first LSP operation. */
	private lsp: LspClient | null = null;
	private lspStarting: Promise<LspClient> | null = null;
	/** Permanently broken — spawn or initialize failed; never retry. */
	private lspBroken = false;

	constructor(opts: LocalCodeIntelBackendOptions) {
		this.cwd = opts.cwd;
		this.writableRoots = opts.writableRoots;
	}

	/**
	 * Pre-warm the LSP client. Called by Adapter.ready() before the first event.
	 * LSP is optional — warm-up failure is silently swallowed so the adapter
	 * still mounts and serves grep-based results without LSP.
	 */
	async warmUp(): Promise<void> {
		try {
			await this.getLsp();
		} catch (error) {
			traceEvent("code-intel:warmup:failed", { error: String(error), cwd: this.cwd });
			// LSP is optional — warm-up failure is non-fatal
		}
	}

	/** Stop the LSP server if one was started. Called on adapter unmount. */
	async stopLsp(): Promise<void> {
		const lsp = this.lsp;
		this.lsp = null;
		this.lspStarting = null;
		await lsp?.stop();
	}

	private async getLsp(): Promise<LspClient> {
		if (this.lsp) return this.lsp;
		if (this.lspBroken) throw new Error("LSP server unavailable for this session");
		this.lspStarting ??= LspClient.start(this.cwd)
			.then((c) => {
				this.lsp = c;
				return c;
			})
			.catch((e) => {
				this.lspBroken = true;
				this.lspStarting = null;
				throw e;
			});
		return this.lspStarting;
	}

	// -------------------------------------------------------------------------
	// callers (LSP callHierarchy for TS files + grep fallback)
	// -------------------------------------------------------------------------

	async callers(symbol: string, opts: CallersOptions = {}): Promise<CallSite[]> {
		const maxResults = opts.maxResults ?? DEFAULT_MAX_RESULTS_CALLERS;
		for (const strategy of this._callersStrategies) {
			if (!strategy.canHandle(opts)) continue;
			try {
				return await strategy.resolve(this, symbol, opts, maxResults);
			} catch (error) {
				traceEvent("code-intel:callers:strategy-failed", { symbol, path: opts.path, error: String(error) });
				// strategy unavailable — try next
			}
		}
		return [];
	}

	private readonly _callersStrategies: CallersStrategy[] = [
		{
			canHandle: (opts) => !!(opts.path && isTsFile(opts.path)),
			resolve: async (backend, symbol, opts, maxResults) =>
				backend._callersViaLsp(symbol, opts.path ?? "", maxResults),
		},
		{
			canHandle: () => true,
			resolve: async (backend, symbol, opts, maxResults) => backend._callersViaGrep(symbol, opts, maxResults),
		},
	];

	private async _callersViaLsp(symbol: string, filePath: string, maxResults: number): Promise<CallSite[]> {
		const abs = resolvePath(this.cwd, filePath, this.writableRoots);
		const content = await readFile(abs, "utf-8");
		const fileUrl = pathToFileURL(abs).href;

		// Find the symbol's position from extracted symbols.
		const symbols = extractSymbolsFor(content, filePath);
		const sym = symbols.find((s) => s.name === symbol);
		if (!sym) throw new Error(`LSP callers: symbol '${symbol}' not found in ${filePath}`);

		const lsp = await this.getLsp();
		await lsp.openFile(fileUrl, content);

		// Use the identifier's exact column so prepareCallHierarchy hits the name token.
		return lsp.incomingCalls(fileUrl, sym.startLine - 1, sym.startCharacter ?? 0, maxResults);
	}

	private async _callersViaGrep(symbol: string, opts: CallersOptions, maxResults: number): Promise<CallSite[]> {
		const matches = await this._grepSearch(symbol, {
			path: opts.path,
			maxResults: maxResults * 2,
		});
		const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const DECL_RE = new RegExp(String.raw`\b(?:function|class|interface|type|const|let|var)\s+${escaped}\b`);
		const callers: CallSite[] = [];
		for (const m of matches) {
			if (callers.length >= maxResults) break;
			if (DECL_RE.test(m.content)) continue;
			callers.push({ path: m.path, line: m.line, context: m.content.trim() });
		}
		return callers;
	}

	// Helper: grep search (used by callers fallback)
	private async _grepSearch(
		pattern: string,
		opts: { path?: string; maxResults?: number },
	): Promise<Array<{ path: string; line: number; content: string }>> {
		const searchRoot = opts.path ? resolvePath(this.cwd, opts.path, this.writableRoots) : this.cwd;
		const maxResults = opts.maxResults ?? DEFAULT_MAX_RESULTS_SEARCH;

		const args = ["-rn", "--color=never", "--", pattern, searchRoot];

		// Try ripgrep first, fall back to grep.
		for (const cmd of ["rg", "grep"]) {
			const isRg = cmd === "rg";
			const rgArgs = isRg ? ["-n", "--color=never", "--no-heading", "--", pattern, searchRoot] : args;

			try {
				const { stdout, exitCode } = await spawnCollect(cmd, rgArgs, this.cwd);
				if (exitCode > 1) continue; // 1 = no matches (ok), >1 = error
				return this._parseGrepOutput(stdout, maxResults);
			} catch (error) {
				traceEvent("code-intel:grep:failed", { cmd, pattern, searchRoot, error: String(error) });
				// command not found or failed — try next
			}
		}

		return [];
	}

	private _parseGrepOutput(
		stdout: string,
		maxResults: number,
	): Array<{ path: string; line: number; content: string }> {
		const matches: Array<{ path: string; line: number; content: string }> = [];
		for (const line of stdout.split("\n")) {
			if (matches.length >= maxResults) break;
			const m = line.match(/^(.+?):(\d+):(.*)/);
			if (!m) continue;
			matches.push({
				path: m[1],
				line: Number.parseInt(m[2], 10),
				content: m[3],
			});
		}
		return matches;
	}

	// -------------------------------------------------------------------------
	// LSP-backed methods (diagnostics, hover, workspace symbols)
	// -------------------------------------------------------------------------

	// eslint-disable-next-line @typescript-eslint/consistent-type-imports
	async getDiagnostics(path: string): Promise<import("./backend.js").Diagnostic[]> {
		if (!isTsFile(path)) return [];

		const abs = resolvePath(this.cwd, path, this.writableRoots);
		const fileUrl = pathToFileURL(abs).href;

		try {
			const lsp = await this.getLsp();
			const content = await readFile(abs, "utf-8");
			await lsp.openFile(fileUrl, content);

			// Wait a bit for diagnostics to be computed
			// lint-ignore: RAWTIMER deliberate diagnostic computation delay
			await new Promise((r) => setTimeout(r, 500));

			const diags = await lsp.getDiagnostics(fileUrl);

			return diags.map((d) => ({
				severity: d.severity,
				message: d.message,
				line: d.range.start.line + 1, // Convert to 1-indexed
				character: d.range.start.character,
				code: d.code,
				source: d.source,
			}));
		} catch (error) {
			traceEvent("code-intel:diagnostics:failed", { path, error: String(error) });
			// LSP unavailable — return empty
			return [];
		}
	}

	// eslint-disable-next-line @typescript-eslint/consistent-type-imports
	async getHover(path: string, line: number, character: number): Promise<import("./backend.js").HoverInfo | null> {
		if (!isTsFile(path)) return null;

		const abs = resolvePath(this.cwd, path, this.writableRoots);
		const fileUrl = pathToFileURL(abs).href;

		try {
			const lsp = await this.getLsp();
			const content = await readFile(abs, "utf-8");
			await lsp.openFile(fileUrl, content);

			return await lsp.getHover(fileUrl, line - 1, character); // Convert to 0-indexed
		} catch (error) {
			traceEvent("code-intel:hover:failed", { path, line, character, error: String(error) });
			return null;
		}
	}

	// eslint-disable-next-line @typescript-eslint/consistent-type-imports
	async workspaceSymbols(query: string): Promise<import("./backend.js").WorkspaceSymbol[]> {
		try {
			const lsp = await this.getLsp();
			const symbols = await lsp.workspaceSymbols(query);

			// Map LSP SymbolKind enum to human-readable strings
			const kindMap: Record<number, string> = {
				1: "file",
				2: "module",
				3: "namespace",
				4: "package",
				5: "class",
				6: "method",
				7: "property",
				8: "field",
				9: "constructor",
				10: "enum",
				11: "interface",
				12: "function",
				13: "variable",
				14: "constant",
				15: "string",
				16: "number",
				17: "boolean",
				18: "array",
			};

			return symbols.map((s) => ({
				name: s.name,
				kind: kindMap[s.kind] || "unknown",
				path: s.location.uri.startsWith("file://") ? fileURLToPath(s.location.uri) : s.location.uri,
				line: s.location.range.start.line + 1, // Convert to 1-indexed
				containerName: s.containerName,
			}));
		} catch (error) {
			traceEvent("code-intel:workspace-symbols:failed", { query, error: String(error) });
			return [];
		}
	}
}
