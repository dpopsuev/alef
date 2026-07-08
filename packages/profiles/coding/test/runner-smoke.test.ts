/**
 * Real-LLM integration smoke tests.
 *
 * Three tiers:
 *   Tier 1 (identity)    — agent replies non-empty. Weak; proves boot + API path.
 *   Tier 2 (unforgeable) — agent reads a UUID from a file it cannot know without
 *                          calling fs.read. Reply must contain the UUID.
 *   Tier 3 (multi-turn)  — turn 1 reads a file; turn 2 asks a follow-up question
 *                          that is only answerable from turn 1's tool result.
 *
 * All tests boot the runner as a real subprocess via HTTP/SSE — the same surface
 * used by web clients and daemon mode.
 *
 * Guard: any LLM credentials (API key or Vertex config) must be present.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hasCredentials } from "@dpopsuev/alef-agent/model";

// ---------------------------------------------------------------------------
// Guard — skip when no provider credentials are available
// ---------------------------------------------------------------------------

const HAS_KEY = hasCredentials();

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "../../..");
const TSX = resolve(ROOT, "node_modules/tsx/dist/cli.mjs");
const RUNNER_MAIN = resolve(__dirname, "../../runner/src/main.ts");
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
	return match[1]!;
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
			() => reject(new Error(`SSE timeout after ${timeoutMs}ms — no llm.response received`)),
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
							if (ev.bus === "command" && ev.type === "llm.response" && ev.payload?.text) {
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

describe.skipIf(!HAS_KEY)("Real-LLM — full stack integration", { tags: ["real-llm"] }, () => {
	it("agent replies non-empty to 'Who are you?' (motor/llm.response asserted via SSE)", async () => {
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
			// RouterAdapter returns 202 Accepted for async message dispatch.
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
			// This is the regression: previously the command/llm.response was generated
			// in the JSONL but the TUI didn't render it (silent empty screen).
			expect(reply.length).toBeGreaterThan(10);
		} finally {
			proc.kill("SIGTERM");
		}
	}, 65_000);
});

// ---------------------------------------------------------------------------
// Tier 2 — Unforgeable file-read test
//
// Writes a UUID the agent cannot know without calling fs.read. The reply MUST
// contain the exact UUID — pure guessing has probability ~10^-37.
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_KEY)("Unforgeable — agent must use fs.read to answer", { tags: ["real-llm"] }, () => {
	it("reads secret.txt and returns the UUID verbatim", async () => {
		const cwd = makeTmp();
		const secret = randomUUID();
		writeFileSync(join(cwd, "secret.txt"), `SECRET=${secret}\n`, "utf-8");

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
			await postJson(`${baseUrl}/message`, {
				text: "Read the file secret.txt and tell me the value of SECRET. Output only the value, nothing else.",
			});

			const reply = await replyPromise;

			// The UUID must appear literally — the agent had to read the file.
			expect(reply).toContain(secret);
		} finally {
			proc.kill("SIGTERM");
		}
	}, 90_000);
});

// ---------------------------------------------------------------------------
// Tier 3 — Multi-turn context carry
//
// Turn 1: agent reads a file containing a code word.
// Turn 2: asks what the code word was — answerable only from turn 1's memory.
// Verifies that session history is maintained across turns.
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_KEY)("Multi-turn — context carries across turns", { tags: ["real-llm"] }, () => {
	it("turn 2 recalls content read in turn 1 without re-reading the file", async () => {
		const cwd = makeTmp();
		const codeWord = `ALEF-${randomUUID().slice(0, 8).toUpperCase()}`;
		writeFileSync(join(cwd, "code.txt"), `CODE=${codeWord}\n`, "utf-8");

		const proc = spawn(process.execPath, [TSX, RUNNER_MAIN, "--serve", "0", "--no-tui"], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, TSX_TSCONFIG_PATH: TSCONFIG },
		});

		try {
			const output = await waitForOutput(proc, /router listening on/, 20_000);
			const baseUrl = parseRouterAddress(output);

			// Turn 1 — read the file.
			const reply1Promise = collectSseUntilDialogMessage(baseUrl, 55_000);
			await new Promise((r) => setTimeout(r, 50));
			await postJson(`${baseUrl}/message`, {
				text: "Read code.txt and remember the value of CODE.",
			});
			const reply1 = await reply1Promise;
			expect(reply1).toContain(codeWord);

			// Turn 2 — ask without mentioning the file.
			const reply2Promise = collectSseUntilDialogMessage(baseUrl, 55_000);
			await new Promise((r) => setTimeout(r, 100));
			await postJson(`${baseUrl}/message`, {
				text: "What was the CODE value? Output only the value.",
			});
			const reply2 = await reply2Promise;

			// The agent must recall from turn 1 — code word appears in turn 2 reply.
			expect(reply2).toContain(codeWord);
		} finally {
			proc.kill("SIGTERM");
		}
	}, 120_000);
});
