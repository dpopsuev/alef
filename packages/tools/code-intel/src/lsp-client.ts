/**
 * LSP stdio JSON-RPC client for typescript-language-server.
 *
 * Implements the minimum LSP surface needed for code.callers:
 *   initialize → callHierarchy/prepareCallHierarchy → callHierarchy/incomingCalls
 *
 * Protocol:
 *   Messages are framed with "Content-Length: N\r\n\r\n" headers (LSP spec).
 *   Responses are matched by id. Notifications (no id) are discarded.
 *
 * Lifecycle:
 *   LspClient.start(cwd)  — spawns the server, sends initialize + initialized
 *   client.incomingCalls(uri, symbol)  — returns CallSite[]
 *   client.stop()  — sends shutdown + exit, kills subprocess
 *
 * The client is lazy-started by LocalCodeIntelBackend on the first callers() call
 * and kept alive for the session. It is closed on adapter unmount.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { traceEvent } from "@dpopsuev/alef-kernel/log";
import type { CallSite } from "./backend.js";

// ---------------------------------------------------------------------------
// Path to typescript-language-server binary
// ---------------------------------------------------------------------------

// Resolved via import.meta.resolve so it works regardless of compiled output
// location or workspace hoisting depth.
const LSP_BIN = fileURLToPath(import.meta.resolve("typescript-language-server/lib/cli.mjs"));

// ---------------------------------------------------------------------------
// JSON-RPC framing
// ---------------------------------------------------------------------------

/**
 *
 */
function encode(msg: object): Buffer {
	const body = JSON.stringify(msg);
	const header = `Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n`;
	return Buffer.from(header + body, "utf-8");
}

// ---------------------------------------------------------------------------
// LspClient
// ---------------------------------------------------------------------------

interface PendingRequest {
	resolve: (result: unknown) => void;
	reject: (err: Error) => void;
}

/**
 *
 */
export class LspClient {
	private readonly proc: ReturnType<typeof spawn>;
	private readonly pending = new Map<number, PendingRequest>();
	private nextId = 1;
	private buf = "";
	private ready = false;
	private initPromise: Promise<void>;

	private constructor(proc: ReturnType<typeof spawn>, cwd: string) {
		this.proc = proc;

		// Parse incoming messages.
		proc.stdout?.on("data", (data: Buffer) => {
			this.buf += data.toString("utf-8");
			this._drain();
		});

		proc.stderr?.on("data", (data: Buffer) => {
			traceEvent("lsp:stderr", { text: data.toString("utf-8").trimEnd() });
		});

		// Initialize the server.
		this.initPromise = this._initialize(cwd);
	}

	static async start(cwd: string): Promise<LspClient> {
		if (!existsSync(LSP_BIN)) {
			throw new Error(
				`typescript-language-server not found at ${LSP_BIN}. ` +
					"Install: npm install typescript-language-server --workspace=@dpopsuev/alef-tool-code-intel",
			);
		}

		const proc = spawn(LSP_BIN, ["--stdio"], {
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
		});

		const client = new LspClient(proc, cwd);
		await client.initPromise;
		return client;
	}

	private _drain(): void {
		// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- idiomatic infinite loop
		while (true) {
			const headerEnd = this.buf.indexOf("\r\n\r\n");
			if (headerEnd === -1) break;
			const header = this.buf.slice(0, headerEnd);
			const lenMatch = header.match(/Content-Length:\s*(\d+)/i);
			if (!lenMatch) {
				this.buf = "";
				break;
			}
			const len = Number.parseInt(lenMatch[1], 10);
			const bodyStart = headerEnd + 4;
			if (this.buf.length < bodyStart + len) break;
			const body = this.buf.slice(bodyStart, bodyStart + len);
			this.buf = this.buf.slice(bodyStart + len);
			try {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- JSON.parse returns unknown; shape validated by id/error checks below
				const msg = JSON.parse(body) as { id?: number; result?: unknown; error?: { message: string } };
				if (msg.id !== undefined) {
					const p = this.pending.get(msg.id);
					if (p) {
						this.pending.delete(msg.id);
						if (msg.error) p.reject(new Error(msg.error.message));
						else p.resolve(msg.result);
					}
				}
			} catch {
				/* ignore parse errors */
			}
		}
	}

	private _send(method: string, params: unknown, id?: number): void {
		const msg: Record<string, unknown> = {
			jsonrpc: "2.0",
			method,
			params,
		};
		if (id !== undefined) msg.id = id;
		this.proc.stdin?.write(encode(msg));
	}

	private _request(method: string, params: unknown, timeoutMs = 10_000): Promise<unknown> {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			// lint-ignore: RAWTIMER LSP protocol request deadline
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`LSP timeout: ${method}`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (v) => {
					clearTimeout(timer);
					resolve(v);
				},
				reject: (e) => {
					clearTimeout(timer);
					reject(e);
				},
			});
			this._send(method, params, id);
		});
	}

	private async _initialize(cwd: string): Promise<void> {
		await this._request("initialize", {
			processId: process.pid,
			rootUri: pathToFileURL(cwd).href,
			capabilities: {
				textDocument: {
					callHierarchy: { dynamicRegistration: false },
				},
			},
			initializationOptions: {},
		});
		this._send("initialized", {});
		this.ready = true;
	}

	/**
	 * Open a file in the LSP server (required before querying its symbols).
	 */
	async openFile(uri: string, content: string, languageId = "typescript"): Promise<void> {
		this._send("textDocument/didOpen", {
			textDocument: { uri, languageId, version: 1, text: content },
		});
		// lint-ignore: RAWTIMER deliberate indexing delay, not a deadline
		await new Promise((r) => setTimeout(r, 200));
	}

	/**
	 * Get incoming call sites for a symbol at the given position.
	 * Returns up to maxResults caller locations.
	 */
	async incomingCalls(
		fileUri: string,
		line: number, // 0-indexed
		character: number, // 0-indexed
		maxResults = 100,
	): Promise<CallSite[]> {
		if (!this.ready) throw new Error("LspClient: not initialized");

		// Prepare call hierarchy at the cursor position.
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- LSP response shape defined by protocol spec
		const items = (await this._request("textDocument/prepareCallHierarchy", {
			textDocument: { uri: fileUri },
			position: { line, character },
		})) as Array<{
			uri: string;
			name: string;
			selectionRange: { start: { line: number; character: number } };
		}> | null;

		if (!items || items.length === 0) return [];

		// Get incoming calls for the first item.
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- LSP response shape defined by protocol spec
		const calls = (await this._request("callHierarchy/incomingCalls", {
			item: items[0],
		})) as Array<{
			from: { uri: string; name: string };
			fromRanges: Array<{ start: { line: number } }>;
		}> | null;

		if (!calls) return [];

		const results: CallSite[] = [];
		for (const call of calls.slice(0, maxResults)) {
			const callerUri = call.from.uri;
			const callerLine = call.fromRanges[0]?.start.line ?? 0;
			// Convert URI to relative path.
			const callerPath = callerUri.startsWith("file://") ? fileURLToPath(callerUri) : callerUri;
			results.push({
				path: callerPath,
				line: callerLine + 1, // 1-indexed
				context: `${call.from.name}`,
			});
		}

		return results;
	}

	/**
	 * Get diagnostics (compilation errors/warnings) for a file.
	 */
	async getDiagnostics(fileUri: string): Promise<
		Array<{
			severity: number; // 1=error, 2=warning, 3=info, 4=hint
			message: string;
			range: { start: { line: number; character: number }; end: { line: number; character: number } };
			code?: string | number;
			source?: string;
		}>
	> {
		if (!this.ready) throw new Error("LspClient: not initialized");

		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- LSP response shape defined by protocol spec
		const result = (await this._request("textDocument/diagnostic", {
			textDocument: { uri: fileUri },
		})) as {
			items?: Array<{
				severity: number;
				message: string;
				range: { start: { line: number; character: number }; end: { line: number; character: number } };
				code?: string | number;
				source?: string;
			}>;
		} | null;

		return result?.items ?? [];
	}

	/**
	 * Get hover information (type info, documentation) at a position.
	 */
	async getHover(
		fileUri: string,
		line: number,
		character: number,
	): Promise<{
		contents: string;
		range?: { start: { line: number; character: number }; end: { line: number; character: number } };
	} | null> {
		if (!this.ready) throw new Error("LspClient: not initialized");

		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- LSP response shape defined by protocol spec
		const result = (await this._request("textDocument/hover", {
			textDocument: { uri: fileUri },
			position: { line, character },
		})) as {
			contents: { kind?: string; value: string } | string | Array<{ language?: string; value: string }>;
			range?: { start: { line: number; character: number }; end: { line: number; character: number } };
		} | null;

		if (!result) return null;

		// Normalize contents to string
		let contents: string;
		if (typeof result.contents === "string") {
			contents = result.contents;
		} else if (Array.isArray(result.contents)) {
			contents = result.contents.map((c) => c.value).join("\n");
		} else {
			contents = result.contents.value;
		}

		return { contents, range: result.range };
	}

	/**
	 * Search for symbols across the workspace.
	 */
	async workspaceSymbols(query: string): Promise<
		Array<{
			name: string;
			kind: number; // LSP SymbolKind enum
			location: {
				uri: string;
				range: { start: { line: number; character: number }; end: { line: number; character: number } };
			};
			containerName?: string;
		}>
	> {
		if (!this.ready) throw new Error("LspClient: not initialized");

		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- LSP response shape defined by protocol spec
		const result = (await this._request("workspace/symbol", {
			query,
		})) as Array<{
			name: string;
			kind: number;
			location: {
				uri: string;
				range: { start: { line: number; character: number }; end: { line: number; character: number } };
			};
			containerName?: string;
		}> | null;

		return result ?? [];
	}

	async stop(): Promise<void> {
		if (!this.ready) return;
		try {
			await this._request("shutdown", null, 3_000);
			this._send("exit", null);
		} catch {
			/* ignore timeout on shutdown */
		}
		this.proc.kill();
		this.pending.clear();
	}
}
