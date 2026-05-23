/**
 * Real-LLM integration test — "Who am I?"
 *
 * Boots the runner against a real provider (skipped when no API key is set),
 * sends a prompt via POST /message, collects the motor/dialog.message event
 * from the SSE stream, and asserts the reply is non-empty.
 *
 * This exercises the FULL stack:
 *   User message → organ-dialog → organ-llm → provider API → text chunks
 *   → dialog.message published → SSE event emitted → collectSse resolves
 *
 * Guards:
 *   - ANTHROPIC_API_KEY (or any auto-detected provider key) must be set
 *   - Runner boots with --no-tui --serve 0 (no terminal needed)
 *   - Timeout: 60s (real LLM may be slow)
 *
 * Run manually:
 *   cd packages/runner
 *   ANTHROPIC_API_KEY=sk-ant-... npx tsx ../../node_modules/vitest/dist/cli.js \
 *     --run test/real-llm.test.ts
 */

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Guard — skip when no provider credentials are available
// ---------------------------------------------------------------------------

const HAS_KEY =
	!!process.env.ANTHROPIC_API_KEY ||
	!!process.env.OPENAI_API_KEY ||
	!!process.env.GEMINI_API_KEY ||
	!!process.env.OPENROUTER_API_KEY;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "../../..");
const TSX = resolve(ROOT, "node_modules/tsx/dist/cli.mjs");
const RUNNER_MAIN = resolve(__dirname, "../src/main.ts");
const TSCONFIG = resolve(ROOT, "tsconfig.json");

// ---------------------------------------------------------------------------
// Helpers (shared with lifecycle-supervisor.test.ts)
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];
afterEach(() => {
	for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeTmp(): string {
	const d = mkdtempSync(`${tmpdir()}/alef-real-llm-`);
	tempDirs.push(d);
	return d;
}

function waitForOutput(proc: ChildProcess, pattern: RegExp, timeoutMs: number): Promise<string> {
	return new Promise((resolve, reject) => {
		let buf = "";
		const timer = setTimeout(
			() => reject(new Error(`Timeout after ${timeoutMs}ms waiting for ${pattern}\n${buf.slice(-500)}`)),
			timeoutMs,
		);
		const onData = (chunk: Buffer) => {
			buf += chunk.toString();
			if (pattern.test(buf)) {
				clearTimeout(timer);
				proc.stdout?.off("data", onData);
				proc.stderr?.off("data", onData);
				resolve(buf);
			}
		};
		proc.stdout?.on("data", onData);
		proc.stderr?.on("data", onData);
		proc.on("exit", (code) => {
			clearTimeout(timer);
			reject(new Error(`Process exited (${code}) before pattern ${pattern}\n${buf.slice(-500)}`));
		});
	});
}

function parseRouterAddress(output: string): string {
	const match = output.match(/router listening on (http:\/\/[\d.]+:\d+)/);
	if (!match) throw new Error(`Could not parse router address:\n${output.slice(-300)}`);
	return match[1];
}

function postJson(url: string, body: unknown): Promise<{ status: number; json: unknown }> {
	return new Promise((resolve, reject) => {
		const data = JSON.stringify(body);
		const parsed = new URL(url);
		const req = http.request(
			{
				hostname: parsed.hostname,
				port: Number(parsed.port),
				path: parsed.pathname,
				method: "POST",
				headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
			},
			(res) => {
				let raw = "";
				res.on("data", (c: Buffer) => {
					raw += c.toString();
				});
				res.on("end", () => {
					try {
						resolve({ status: res.statusCode ?? 0, json: JSON.parse(raw) });
					} catch {
						resolve({ status: res.statusCode ?? 0, json: raw });
					}
				});
			},
		);
		req.on("error", reject);
		req.write(data);
		req.end();
	});
}

function collectSseUntilDialogMessage(baseUrl: string, timeoutMs: number): Promise<string> {
	return new Promise((resolve, reject) => {
		let buf = "";
		const timer = setTimeout(
			() => reject(new Error(`SSE timeout after ${timeoutMs}ms — no dialog.message received`)),
			timeoutMs,
		);
		http
			.get(`${baseUrl}/events`, (res) => {
				res.on("data", (chunk: Buffer) => {
					buf += chunk.toString();
					const frames = buf.split("\n\n");
					buf = frames.pop() ?? "";
					for (const frame of frames) {
						const line = frame.split("\n").find((l) => l.startsWith("data: "));
						if (!line) continue;
						try {
							const ev = JSON.parse(line.slice(6)) as {
								bus?: string;
								type?: string;
								payload?: { text?: string };
							};
							if (ev.bus === "motor" && ev.type === "dialog.message" && ev.payload?.text) {
								clearTimeout(timer);
								res.destroy();
								resolve(ev.payload.text);
							}
						} catch {
							/* skip malformed */
						}
					}
				});
				res.on("error", (err) => {
					if ((err as NodeJS.ErrnoException).code === "ERR_STREAM_DESTROYED") return;
					clearTimeout(timer);
					reject(err);
				});
			})
			.on("error", reject);
	});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_KEY)("Real-LLM — full stack integration", () => {
	it("agent replies non-empty to 'Who are you?' (motor/dialog.message asserted via SSE)", async () => {
		const cwd = makeTmp();

		const proc = spawn(process.execPath, [TSX, RUNNER_MAIN, "--serve", "0", "--no-tui"], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, TSX_TSCONFIG_PATH: TSCONFIG },
		});

		try {
			const output = await waitForOutput(proc, /router listening on/, 20_000);
			const baseUrl = parseRouterAddress(output);

			// Start collecting SSE before sending the message.
			const replyPromise = collectSseUntilDialogMessage(baseUrl, 55_000);

			await new Promise((r) => setTimeout(r, 50));
			const { status } = await postJson(`${baseUrl}/message`, { text: "Who are you? Reply in one sentence." });
			// RouterOrgan returns 202 Accepted for async message dispatch.
			expect(status).toBe(202);

			const reply = await replyPromise;

			// Core assertion: a non-empty text reply arrived on the bus.
			expect(reply.length).toBeGreaterThan(10);
			// Sanity: the reply should mention being an AI or agent.
			expect(reply.toLowerCase()).toMatch(/ai|agent|assistant|language model|alef/i);
		} finally {
			proc.kill("SIGTERM");
		}
	}, 65_000);

	it("reply arrives on motor bus even after tool calls (regression: silent empty reply)", async () => {
		const cwd = makeTmp();

		const proc = spawn(process.execPath, [TSX, RUNNER_MAIN, "--serve", "0", "--no-tui"], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, TSX_TSCONFIG_PATH: TSCONFIG },
		});

		try {
			const output = await waitForOutput(proc, /router listening on/, 20_000);
			const baseUrl = parseRouterAddress(output);

			const replyPromise = collectSseUntilDialogMessage(baseUrl, 55_000);

			await new Promise((r) => setTimeout(r, 50));
			// Prompt likely to trigger fs tool calls followed by a text summary.
			await postJson(`${baseUrl}/message`, {
				text: "List the files in the current directory and tell me what you see.",
			});

			const reply = await replyPromise;

			// The reply MUST be non-empty even after tool calls.
			// This is the regression: previously the motor/dialog.message was generated
			// in the JSONL but the TUI didn't render it (silent empty screen).
			expect(reply.length).toBeGreaterThan(10);
		} finally {
			proc.kill("SIGTERM");
		}
	}, 65_000);
});
