/**
 * Lifecycle supervisor integration tests — RED.
 *
 * These tests verify the runner's ability to operate under the supervisor:
 *
 *   1. Boot without a real LLM via ALEF_SCRIPTED_REPLIES env var
 *   2. Handle IPC handoff_prepare from the supervisor
 *   3. SSE stream survives a supervisor blue-green cycle
 *   4. Session handoff: new runner green resumes previous session
 *
 * Currently failing (red) because:
 *   - Runner has no ALEF_SCRIPTED_REPLIES support (exits with "no model" error)
 *   - Runner has no process.on("message") IPC handler for supervisor messages
 *
 * Ref: ALE-TSK-182 (remaining checklist items)
 */

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "../../..");
const TSX = resolve(ROOT, "node_modules/tsx/dist/cli.mjs");
const RUNNER_MAIN = resolve(__dirname, "../src/main.ts");
// Supervisor binary removed with coding-agent. Tests below that use SUPERVISOR
// are skipped until an organ-native supervisor is implemented (ALE-GOL-11).
const SUPERVISOR = resolve(__dirname, "../src/main.ts"); // placeholder — no supervisor yet
const TSCONFIG = resolve(ROOT, "tsconfig.json");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];
afterEach(() => {
	for (const d of tempDirs.splice(0)) {
		rmSync(d, { recursive: true, force: true });
	}
});

function makeTmp(): string {
	const d = mkdtempSync(join(tmpdir(), "alef-lc-sup-"));
	tempDirs.push(d);
	return d;
}

/** Wait up to timeoutMs for pattern to appear in accumulated output. */
function waitForOutput(proc: ChildProcess, pattern: RegExp, timeoutMs: number): Promise<string> {
	return new Promise((resolve, reject) => {
		let buf = "";
		const timer = setTimeout(() => {
			reject(new Error(`Timeout after ${timeoutMs}ms waiting for ${pattern}\nOutput:\n${buf.slice(-1000)}`));
		}, timeoutMs);

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
			reject(new Error(`Process exited (${code}) before pattern ${pattern}\nOutput:\n${buf.slice(-1000)}`));
		});
	});
}

/** Parse `http://host:port` from a log line. */
function parseRouterAddress(output: string): string {
	const match = output.match(/router listening on (http:\/\/[\d.]+:\d+)/);
	if (!match) throw new Error(`Could not parse router address from: ${output.slice(-500)}`);
	return match[1];
}

/** GET a URL, return parsed JSON. */
function getJson(url: string): Promise<unknown> {
	return new Promise((resolve, reject) => {
		http
			.get(url, (res) => {
				let body = "";
				res.on("data", (c: Buffer) => {
					body += c.toString();
				});
				res.on("end", () => {
					try {
						resolve(JSON.parse(body));
					} catch {
						reject(new Error(`Bad JSON: ${body}`));
					}
				});
			})
			.on("error", reject);
	});
}

/** POST JSON, return parsed response. */
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

/** Collect N SSE events matching predicate from url/events. */
function collectSse(
	baseUrl: string,
	predicate: (ev: unknown) => boolean,
	count: number,
	timeoutMs = 10_000,
): Promise<unknown[]> {
	return new Promise((resolve, reject) => {
		const collected: unknown[] = [];
		const timer = setTimeout(
			() => reject(new Error(`SSE timeout after ${timeoutMs}ms — got ${collected.length}/${count}`)),
			timeoutMs,
		);
		let buf = "";
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
							const ev = JSON.parse(line.slice(6));
							if (predicate(ev)) {
								collected.push(ev);
								if (collected.length >= count) {
									clearTimeout(timer);
									res.destroy();
									resolve(collected);
								}
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
// Test 1: Runner boots without API key via ALEF_SCRIPTED_REPLIES
//
// RED because: runner exits with "no model configured" — ALEF_SCRIPTED_REPLIES
// is not yet recognised. When green: runner replaces LLMOrgan with
// ScriptedLLMOrgan when this env var is set.
// ---------------------------------------------------------------------------

describe("Runner — ALEF_SCRIPTED_REPLIES", () => {
	it("boots without API key and serves GET /health when ALEF_SCRIPTED_REPLIES is set", async () => {
		const cwd = makeTmp();
		writeFileSync(join(cwd, "README.md"), "# test\n", "utf-8");

		const replies = JSON.stringify(["I am ready."]);

		const proc = spawn(process.execPath, [TSX, RUNNER_MAIN, "--serve", "0", "--no-tui"], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				ALEF_SCRIPTED_REPLIES: replies,
				TSX_TSCONFIG_PATH: TSCONFIG,
			},
		});

		try {
			const output = await waitForOutput(proc, /router listening on/, 20_000);
			const baseUrl = parseRouterAddress(output);
			const health = (await getJson(`${baseUrl}/health`)) as { ok: boolean };
			expect(health.ok).toBe(true);
		} finally {
			proc.kill("SIGTERM");
		}
	}, 30_000);

	it("scripted reply is returned via POST /message when ALEF_SCRIPTED_REPLIES is set", async () => {
		const cwd = makeTmp();

		const replies = JSON.stringify(["I am the agent."]);

		const proc = spawn(process.execPath, [TSX, RUNNER_MAIN, "--serve", "0", "--no-tui"], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				ALEF_SCRIPTED_REPLIES: replies,
				TSX_TSCONFIG_PATH: TSCONFIG,
			},
		});

		try {
			const output = await waitForOutput(proc, /router listening on/, 20_000);
			const baseUrl = parseRouterAddress(output);

			// Collect the agent reply on SSE.
			const ssePromise = collectSse(
				baseUrl,
				(ev) => {
					const e = ev as { bus?: string; type?: string; payload?: { text?: string } };
					return e.bus === "motor" && e.type === "dialog.message" && e.payload?.text === "I am the agent.";
				},
				1,
				10_000,
			);

			await new Promise((r) => setTimeout(r, 50));
			await postJson(`${baseUrl}/message`, { text: "hello" });

			const events = await ssePromise;
			expect(events).toHaveLength(1);
		} finally {
			proc.kill("SIGTERM");
		}
	}, 30_000);
});

// ---------------------------------------------------------------------------
// Test 2: Runner handles IPC handoff_prepare from supervisor
//
// RED because: runner has no process.on("message") handler — it never responds
// to handoff_prepare. When green: runner listens for supervisor messages and
// sends handoff_ack.
// ---------------------------------------------------------------------------

describe("Runner — IPC supervisor handoff", () => {
	it("responds to handoff_prepare with handoff_ack", async () => {
		const cwd = makeTmp();

		const proc = spawn(process.execPath, [TSX, RUNNER_MAIN, "--serve", "0", "--no-tui"], {
			cwd,
			stdio: ["ignore", "pipe", "pipe", "ipc"],
			env: {
				...process.env,
				ALEF_SCRIPTED_REPLIES: JSON.stringify(["ready"]),
				ALEF_SUPERVISOR: "1",
				TSX_TSCONFIG_PATH: TSCONFIG,
			},
		});

		const ackPromise = new Promise<{ type: string; updateId: string }>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("Timeout: runner did not respond to handoff_prepare with handoff_ack")),
				15_000,
			);
			proc.on("message", (msg: unknown) => {
				const m = msg as { type: string; updateId?: string };
				if (m.type === "handoff_ack") {
					clearTimeout(timer);
					resolve(m as { type: string; updateId: string });
				}
			});
			proc.on("exit", (code) => {
				clearTimeout(timer);
				reject(new Error(`Runner exited (${code}) before sending handoff_ack`));
			});
		});

		try {
			// Wait for runner to boot.
			await waitForOutput(proc, /router listening on/, 20_000);

			// Send handoff_prepare.
			const envelope = {
				schemaVersion: "v1",
				updateId: "upd-test-1",
				sourceSlot: "green",
				targetSlot: "blue",
				sessionFile: join(cwd, "session.jsonl"),
				phase: "prepared",
				preparedAt: Date.now(),
			};
			proc.send({ type: "handoff_prepare", envelope });

			const ack = await ackPromise;
			expect(ack.type).toBe("handoff_ack");
			expect(ack.updateId).toBe("upd-test-1");
		} finally {
			proc.kill("SIGTERM");
		}
	}, 30_000);
});

// ---------------------------------------------------------------------------
// Test 3: Supervisor blue-green with runner as green
//
// RED because: depends on Tests 1 + 2 above. The runner must:
//   - Boot without API key (ALEF_SCRIPTED_REPLIES)
//   - Handle IPC handoff (respond to handoff_prepare)
//   - Serve RouterOrgan HTTP (already works)
//
// The supervisor uses ALEF_SUPERVISOR_GREEN_SCRIPT to override the green
// binary with the runner.
// ---------------------------------------------------------------------------

describe.skip("Supervisor — runner as green — RED: requires organ-native supervisor (ALE-GOL-11)", () => {
	it("supervisor spawns runner green, runner serves HTTP, eval gate promotes", async () => {
		const cwd = makeTmp();
		const handoffPath = join(cwd, "handoff.json");

		// Write a thin green script that boots the runner with scripted LLM.
		const greenScript = join(cwd, "green.mjs");
		writeFileSync(
			greenScript,
			`
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const tsx = ${JSON.stringify(TSX)};
const runnerMain = ${JSON.stringify(RUNNER_MAIN)};
const tsconfig = ${JSON.stringify(TSCONFIG)};

const proc = spawn(process.execPath, [tsx, runnerMain, "--serve", "0", "--no-tui"], {
	cwd: process.cwd(),
	stdio: ["inherit", "inherit", "inherit", "ipc"],
	env: {
		...process.env,
		ALEF_SCRIPTED_REPLIES: JSON.stringify(["green reply"]),
		TSX_TSCONFIG_PATH: tsconfig,
	},
});

// Bridge IPC between supervisor and runner.
process.on("message", (msg) => { if (proc.connected) proc.send(msg); });
proc.on("message", (msg) => { if (process.connected) process.send(msg); });
proc.on("exit", (code) => process.exit(code ?? 0));
process.on("SIGTERM", () => proc.kill("SIGTERM"));
`,
			"utf-8",
		);

		const supervisor = spawn(process.execPath, [TSX, SUPERVISOR, "--no-tui"], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				ALEF_SUPERVISOR_GREEN_SCRIPT: greenScript,
				ALEF_SUPERVISOR_BUILD_COMMAND: `${process.execPath} -e "process.exit(0)"`,
				ALEF_SUPERVISOR_PACKAGE_UPDATE_COMMAND: `${process.execPath} -e "process.exit(0)"`,
				ALEF_SUPERVISOR_TEST_EVAL_RESULT: "pass",
				ALEF_SUPERVISOR_SKIP_HEALTH: "1",
				ALEF_SUPERVISOR_HANDOFF_PATH: handoffPath,
				ALEF_SUPERVISOR_AUTO_REBUILD_ON_START: "0",
				TSX_TSCONFIG_PATH: TSCONFIG,
			},
		});

		try {
			// Wait for the runner green to boot and bind its HTTP port.
			const output = await waitForOutput(supervisor, /router listening on/, 25_000);
			const baseUrl = parseRouterAddress(output);

			const health = (await getJson(`${baseUrl}/health`)) as { ok: boolean };
			expect(health.ok).toBe(true);
		} finally {
			supervisor.kill("SIGTERM");
		}
	}, 45_000);

	it("SSE stream receives events from runner green after POST /message", async () => {
		const cwd = makeTmp();
		const handoffPath = join(cwd, "handoff.json");

		const greenScript = join(cwd, "green.mjs");
		writeFileSync(
			greenScript,
			`
import { spawn } from "node:child_process";

const tsx = ${JSON.stringify(TSX)};
const runnerMain = ${JSON.stringify(RUNNER_MAIN)};
const tsconfig = ${JSON.stringify(TSCONFIG)};

const proc = spawn(process.execPath, [tsx, runnerMain, "--serve", "0", "--no-tui"], {
	cwd: process.cwd(),
	stdio: ["inherit", "inherit", "inherit", "ipc"],
	env: {
		...process.env,
		ALEF_SCRIPTED_REPLIES: JSON.stringify(["I see your message."]),
		TSX_TSCONFIG_PATH: tsconfig,
	},
});

process.on("message", (msg) => { if (proc.connected) proc.send(msg); });
proc.on("message", (msg) => { if (process.connected) process.send(msg); });
proc.on("exit", (code) => process.exit(code ?? 0));
process.on("SIGTERM", () => proc.kill("SIGTERM"));
`,
			"utf-8",
		);

		const supervisor = spawn(process.execPath, [TSX, SUPERVISOR, "--no-tui"], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				ALEF_SUPERVISOR_GREEN_SCRIPT: greenScript,
				ALEF_SUPERVISOR_BUILD_COMMAND: `${process.execPath} -e "process.exit(0)"`,
				ALEF_SUPERVISOR_TEST_EVAL_RESULT: "pass",
				ALEF_SUPERVISOR_SKIP_HEALTH: "1",
				ALEF_SUPERVISOR_HANDOFF_PATH: handoffPath,
				TSX_TSCONFIG_PATH: TSCONFIG,
			},
		});

		try {
			const supervisorOutput = await waitForOutput(supervisor, /router listening on/, 25_000);
			const baseUrl = parseRouterAddress(supervisorOutput);

			const ssePromise = collectSse(
				baseUrl,
				(ev) => {
					const e = ev as { bus?: string; type?: string; payload?: { text?: string } };
					return e.bus === "motor" && e.type === "dialog.message" && e.payload?.text === "I see your message.";
				},
				1,
				15_000,
			);

			await new Promise((r) => setTimeout(r, 100));
			await postJson(`${baseUrl}/message`, { text: "hey" });

			const events = await ssePromise;
			expect(events).toHaveLength(1);
		} finally {
			supervisor.kill("SIGTERM");
		}
	}, 60_000);

	it("session handoff: new runner green resumes session after rebuild", async () => {
		const cwd = makeTmp();
		const handoffPath = join(cwd, "handoff.json");

		// The green script boots the runner, waits for one agent reply on SSE,
		// then self-triggers a rebuild via IPC (as a real agent would after writing code).
		// The new green picks up the session via ALEF_CURRENT_SESSION.
		const greenScript = join(cwd, "green.mjs");
		writeFileSync(
			greenScript,
			`
import { spawn } from "node:child_process";
import http from "node:http";

const tsx = ${JSON.stringify(TSX)};
const runnerMain = ${JSON.stringify(RUNNER_MAIN)};
const tsconfig = ${JSON.stringify(TSCONFIG)};
const sessionArgs = process.env.ALEF_CURRENT_SESSION
	? ["--resume", process.env.ALEF_CURRENT_SESSION] : [];

// Pipe runner stderr so we can watch for the router port AND forward to supervisor.
const proc = spawn(process.execPath, [tsx, runnerMain, "--serve", "0", "--no-tui", ...sessionArgs], {
	cwd: process.cwd(),
	stdio: ["inherit", "pipe", "pipe", "ipc"],
	env: { ...process.env, ALEF_SCRIPTED_REPLIES: JSON.stringify(["turn 1 reply", "turn 2 reply"]), TSX_TSCONFIG_PATH: tsconfig },
});

// Forward runner stdout/stderr to our stdout/stderr so supervisor captures them.
proc.stdout.pipe(process.stdout);
proc.stderr.pipe(process.stderr);

process.on("message", (msg) => { if (proc.connected) proc.send(msg); });
proc.on("message", (msg) => { if (process.connected) process.send(msg); });
proc.on("exit", (code) => process.exit(code ?? 0));
process.on("SIGTERM", () => proc.kill("SIGTERM"));

// Watch runner stderr for the router port.
let rebuilt = false;
let buf = "";
proc.stderr.on("data", (chunk) => {
	buf += chunk.toString();
	const m = buf.match(/router listening on http:\\/\\/[\\d.]+:(\\d+)/);
	if (!m || rebuilt) return;
	const port = parseInt(m[1], 10);
	rebuilt = true; // set early to prevent double trigger
	// Connect to SSE and wait for first agent reply.
	http.get("http://127.0.0.1:" + port + "/events", (res) => {
		let sse = "";
		res.on("data", (c) => {
			sse += c.toString();
			const frames = sse.split("\\n\\n");
			sse = frames.pop() || "";
			for (const frame of frames) {
				const line = frame.split("\\n").find(l => l.startsWith("data: "));
				if (!line) continue;
				try {
					const ev = JSON.parse(line.slice(6));
					if (ev.bus === "motor" && ev.type === "dialog.message") {
						res.destroy();
						// Agent replied — request rebuild via supervisor IPC.
						if (typeof process.send === "function") {
							process.send({ type: "rebuild" });
						}
					}
				} catch {}
			}
		});
		res.on("error", () => {});
	}).on("error", () => { rebuilt = false; });
});
`,
			"utf-8",
		);

		const supervisor = spawn(process.execPath, [TSX, SUPERVISOR, "--no-tui"], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				ALEF_SUPERVISOR_GREEN_SCRIPT: greenScript,
				ALEF_SUPERVISOR_BUILD_COMMAND: `${process.execPath} -e "process.exit(0)"`,
				ALEF_SUPERVISOR_TEST_EVAL_RESULT: "pass",
				ALEF_SUPERVISOR_SKIP_HEALTH: "1",
				ALEF_SUPERVISOR_HANDOFF_PATH: handoffPath,
				TSX_TSCONFIG_PATH: TSCONFIG,
			},
		});

		try {
			// Wait for first green to boot.
			const output1 = await waitForOutput(supervisor, /router listening on/, 25_000);
			const baseUrl1 = parseRouterAddress(output1);

			// Send turn 1 — green replies, then self-triggers rebuild via IPC.
			const reply1 = collectSse(
				baseUrl1,
				(ev) => {
					const e = ev as { bus?: string; type?: string; payload?: { text?: string } };
					return e.bus === "motor" && e.type === "dialog.message" && e.payload?.text === "turn 1 reply";
				},
				1,
				15_000,
			);
			await new Promise((r) => setTimeout(r, 100));
			await postJson(`${baseUrl1}/message`, { text: "first" });
			await reply1;

			// Wait for supervisor to promote and spawn new green.
			await waitForOutput(supervisor, /Promoted staging slot/, 35_000);
			const output2 = await waitForOutput(supervisor, /router listening on http/, 25_000);
			const allAddrs = [...output2.matchAll(/router listening on (http:\/\/[\d.]+:\d+)/g)];
			const baseUrl2 = allAddrs.at(-1)![1];

			// Turn 2 — new green handles it (same scripted replies list, fresh index).
			const reply2 = collectSse(
				baseUrl2,
				(ev) => {
					const e = ev as { bus?: string; type?: string; payload?: { text?: string } };
					return e.bus === "motor" && e.type === "dialog.message";
				},
				1,
				15_000,
			);
			await new Promise((r) => setTimeout(r, 100));
			await postJson(`${baseUrl2}/message`, { text: "second" });
			await reply2;
			// Both turns completed across a blue-green cycle.
		} finally {
			supervisor.kill("SIGTERM");
		}
	}, 90_000);
});
