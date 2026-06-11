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
const SUPERVISOR = resolve(__dirname, "../src/supervisor.ts");
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
// is not yet recognised. When green: runner replaces Reasoner with
// ScriptedReasoner when this env var is set.
// ---------------------------------------------------------------------------

describe("Runner — ALEF_SCRIPTED_REPLIES", { tags: ["integration"] }, () => {
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
					return e.bus === "motor" && e.type === "llm.response" && e.payload?.text === "I am the agent.";
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

describe("Runner — IPC supervisor handoff", { tags: ["integration"] }, () => {
	// ALE-BUG-35: spurious message before handoff_prepare must not confuse the runner.
	it("ignores unknown IPC messages and still acks the correct handoff_prepare", async () => {
		const cwd = makeTmp();
		const proc = spawn(process.execPath, [TSX, RUNNER_MAIN, "--serve", "0", "--no-tui"], {
			cwd,
			stdio: ["ignore", "pipe", "pipe", "ipc"],
			env: {
				...process.env,
				ALEF_SCRIPTED_REPLIES: JSON.stringify(["ok"]),
				ALEF_SUPERVISOR: "1",
				TSX_TSCONFIG_PATH: TSCONFIG,
			},
		});

		const messages: unknown[] = [];
		const ackPromise = new Promise<{ type: string; updateId: string }>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("Timeout: no handoff_ack received")), 15_000);
			proc.on("message", (msg: unknown) => {
				messages.push(msg);
				const m = msg as { type?: string; updateId?: string };
				if (m.type === "handoff_ack") {
					clearTimeout(timer);
					resolve(m as { type: string; updateId: string });
				}
			});
			proc.on("exit", (code) => {
				clearTimeout(timer);
				reject(new Error(`Exited (${code}) before ack`));
			});
		});

		try {
			await waitForOutput(proc, /router listening on/, 20_000);

			// Inject a spurious message before sending the real handoff_prepare.
			proc.send({ type: "handoff_ack", updateId: "stale-from-previous-swap" });
			proc.send({ type: "unknown_message_type", data: 42 });

			// Now send the real handoff_prepare.
			proc.send({ type: "handoff_prepare", envelope: { updateId: "correct-id", schemaVersion: "v1" } });

			const ack = await ackPromise;
			expect(ack.type).toBe("handoff_ack");
			expect(ack.updateId).toBe("correct-id");
			// Runner must emit exactly one ack (not confused by spurious messages).
			const acks = messages.filter((m) => (m as { type?: string }).type === "handoff_ack");
			expect(acks).toHaveLength(1);
		} finally {
			proc.kill("SIGTERM");
		}
	}, 30_000);

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

describe("Supervisor — TypeScript green script", { tags: ["integration"] }, () => {
	it("spawns a .ts GREEN_SCRIPT directly via tsx without a wrapper", async () => {
		// Verifies the spawnGreen() tsx-detection fix: when GREEN_SCRIPT ends in .ts,
		// the supervisor prepends the tsx binary so TypeScript source runs directly.
		const cwd = makeTmp();

		const supervisor = spawn(process.execPath, [TSX, SUPERVISOR], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				// Point GREEN_SCRIPT at the real runner main.ts — no .mjs wrapper needed.
				ALEF_SUPERVISOR_GREEN_SCRIPT: RUNNER_MAIN,
				ALEF_SUPERVISOR_BUILD_COMMAND: `${process.execPath} -e "process.exit(0)"`,
				ALEF_SUPERVISOR_SKIP_HEALTH: "1",
				ALEF_SUPERVISOR_AUTO_REBUILD_ON_START: "0",
				ALEF_SUPERVISOR_TSX_BIN: TSX,
				// Pass --serve 0 --no-tui to the green so it binds HTTP instead of TUI.
				ALEF_SUPERVISOR_GREEN_ARGS: JSON.stringify(["--serve", "0", "--no-tui"]),
				ALEF_SCRIPTED_REPLIES: JSON.stringify(["ts-green-ok"]),
				TSX_TSCONFIG_PATH: TSCONFIG,
			},
		});

		try {
			const output = await waitForOutput(supervisor, /router listening on/, 30_000);
			const baseUrl = parseRouterAddress(output);
			const health = (await getJson(`${baseUrl}/health`)) as { ok: boolean };
			expect(health.ok).toBe(true);
		} finally {
			supervisor.kill("SIGTERM");
		}
	}, 45_000);
});

describe("Supervisor — runner as green", { tags: ["integration"] }, () => {
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

		const supervisor = spawn(process.execPath, [TSX, SUPERVISOR], {
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

		const supervisor = spawn(process.execPath, [TSX, SUPERVISOR], {
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
					return e.bus === "motor" && e.type === "llm.response" && e.payload?.text === "I see your message.";
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
					if (ev.bus === "motor" && ev.type === "llm.response") {
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

		const supervisor = spawn(process.execPath, [TSX, SUPERVISOR], {
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
					return e.bus === "motor" && e.type === "llm.response" && e.payload?.text === "turn 1 reply";
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
					return e.bus === "motor" && e.type === "llm.response";
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

// ---------------------------------------------------------------------------
// Supervisor — unhappy paths (ALE-BUG-32, 33, 34)
// ---------------------------------------------------------------------------

/** Self-triggering green: boots runner, sends { type:"rebuild" } once router is ready. */
function writeSelfTriggerGreen(path: string, extra = ""): void {
	writeFileSync(
		path,
		`
import { spawn } from "node:child_process";
const tsx = ${JSON.stringify(TSX)};
const main = ${JSON.stringify(RUNNER_MAIN)};
const tsconfig = ${JSON.stringify(TSCONFIG)};
const proc = spawn(process.execPath, [tsx, main, "--serve", "0", "--no-tui"], {
  cwd: process.cwd(),
  stdio: ["inherit", "pipe", "pipe", "ipc"],
  env: { ...process.env, ALEF_SCRIPTED_REPLIES: JSON.stringify(["ok"]), TSX_TSCONFIG_PATH: tsconfig, ALEF_SUPERVISOR: "1" },
});
proc.stdout.pipe(process.stdout);
proc.stderr.pipe(process.stderr);
process.on("message", (msg) => { if (proc.connected) proc.send(msg); });
proc.on("message", (msg) => { if (process.connected) process.send(msg); });
proc.on("exit", (code) => process.exit(code ?? 0));
process.on("SIGTERM", () => proc.kill("SIGTERM"));
let triggered = false;
let buf = "";
proc.stderr.on("data", (chunk) => {
  buf += chunk.toString();
  if (!triggered && buf.includes("router listening on")) {
    triggered = true;
    if (typeof process.send === "function") process.send({ type: "rebuild" });
  }
});
${extra}
`,
		"utf-8",
	);
}

describe("Supervisor — unhappy paths", { tags: ["integration"] }, () => {
	// ALE-BUG-34: build command fails — old green must stay live, no promotion.
	it("build failure: old green keeps serving, Promoted staging slot absent", async () => {
		const cwd = makeTmp();
		const greenScript = join(cwd, "green.mjs");
		writeSelfTriggerGreen(greenScript);

		const supervisor = spawn(process.execPath, [TSX, SUPERVISOR], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				ALEF_SUPERVISOR_GREEN_SCRIPT: greenScript,
				ALEF_SUPERVISOR_BUILD_COMMAND: `${process.execPath} -e "process.exit(1)"`,
				ALEF_SUPERVISOR_SKIP_HEALTH: "1",
				ALEF_SUPERVISOR_AUTO_REBUILD_ON_START: "0",
				TSX_TSCONFIG_PATH: TSCONFIG,
			},
		});

		let supervisorOut = "";
		supervisor.stdout?.on("data", (c: Buffer) => {
			supervisorOut += c.toString();
		});
		supervisor.stderr?.on("data", (c: Buffer) => {
			supervisorOut += c.toString();
		});

		try {
			const output = await waitForOutput(supervisor, /router listening on/, 25_000);
			const baseUrl = parseRouterAddress(output);

			const healthBefore = (await getJson(`${baseUrl}/health`)) as { ok: boolean };
			expect(healthBefore.ok).toBe(true);

			// Green self-triggers rebuild; build exits 1; supervisor logs failure.
			await waitForOutput(supervisor, /rebuild failed/, 15_000);

			// Old green must still be alive after failed build.
			const healthAfter = (await getJson(`${baseUrl}/health`)) as { ok: boolean };
			expect(healthAfter.ok).toBe(true);
			expect(supervisorOut).not.toMatch(/Promoted staging slot/);
		} finally {
			supervisor.kill("SIGTERM");
		}
	}, 55_000);

	// ALE-BUG-33: new green crashes during boot — supervisor rolls back to old green.
	it("new green crash: supervisor rolls back, old green keeps serving", async () => {
		const cwd = makeTmp();
		const counterFile = join(cwd, "count");
		const greenScript = join(cwd, "green.mjs");

		// Invocation 0: normal runner that self-triggers rebuild.
		// Invocation 1+: exit immediately — simulates a bad new build.
		writeFileSync(
			greenScript,
			`
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
const tsx = ${JSON.stringify(TSX)};
const main = ${JSON.stringify(RUNNER_MAIN)};
const tsconfig = ${JSON.stringify(TSCONFIG)};
const counterFile = ${JSON.stringify(counterFile)};
const count = existsSync(counterFile) ? parseInt(readFileSync(counterFile, "utf8")) : 0;
writeFileSync(counterFile, String(count + 1));
if (count > 0) { process.exit(1); }
const proc = spawn(process.execPath, [tsx, main, "--serve", "0", "--no-tui"], {
  cwd: process.cwd(),
  stdio: ["inherit", "pipe", "pipe", "ipc"],
  env: { ...process.env, ALEF_SCRIPTED_REPLIES: JSON.stringify(["ok"]), TSX_TSCONFIG_PATH: tsconfig, ALEF_SUPERVISOR: "1" },
});
proc.stdout.pipe(process.stdout);
proc.stderr.pipe(process.stderr);
process.on("message", (msg) => { if (proc.connected) proc.send(msg); });
proc.on("message", (msg) => { if (process.connected) process.send(msg); });
proc.on("exit", (code) => process.exit(code ?? 0));
process.on("SIGTERM", () => proc.kill("SIGTERM"));
let triggered = false, buf = "";
proc.stderr.on("data", (chunk) => {
  buf += chunk.toString();
  if (!triggered && buf.includes("router listening on")) {
    triggered = true;
    if (typeof process.send === "function") process.send({ type: "rebuild" });
  }
});
`,
			"utf-8",
		);

		const supervisor = spawn(process.execPath, [TSX, SUPERVISOR], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				ALEF_SUPERVISOR_GREEN_SCRIPT: greenScript,
				ALEF_SUPERVISOR_BUILD_COMMAND: `${process.execPath} -e "process.exit(0)"`,
				// No SKIP_HEALTH — readyPromise must wait for "router listening on".
				// New green (invocation 1) exits before emitting it → readyReject fires.
				ALEF_SUPERVISOR_AUTO_REBUILD_ON_START: "0",
				TSX_TSCONFIG_PATH: TSCONFIG,
			},
		});

		let supervisorOut = "";
		supervisor.stdout?.on("data", (c: Buffer) => {
			supervisorOut += c.toString();
		});
		supervisor.stderr?.on("data", (c: Buffer) => {
			supervisorOut += c.toString();
		});

		try {
			const output = await waitForOutput(supervisor, /router listening on/, 25_000);
			const baseUrl = parseRouterAddress(output);

			const healthBefore = (await getJson(`${baseUrl}/health`)) as { ok: boolean };
			expect(healthBefore.ok).toBe(true);

			// Green self-triggers rebuild; new green exits → readyReject → rollback.
			await waitForOutput(supervisor, /rebuild failed/, 20_000);

			const healthAfter = (await getJson(`${baseUrl}/health`)) as { ok: boolean };
			expect(healthAfter.ok).toBe(true);
			expect(supervisorOut).not.toMatch(/Promoted staging slot/);
		} finally {
			supervisor.kill("SIGTERM");
		}
	}, 55_000);

	// ALE-BUG-32: old green ignores handoff_prepare — supervisor must promote anyway after 5s.
	it("handoff timeout: supervisor promotes after 5s even without ack", async () => {
		const cwd = makeTmp();
		const counterFile = join(cwd, "count");
		const greenScript = join(cwd, "green.mjs");

		// Invocation 0 (old green): self-triggers rebuild, drops handoff_prepare (no ack).
		// Invocation 1 (new green): normal — boots and serves.
		writeFileSync(
			greenScript,
			`
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
const tsx = ${JSON.stringify(TSX)};
const main = ${JSON.stringify(RUNNER_MAIN)};
const tsconfig = ${JSON.stringify(TSCONFIG)};
const counterFile = ${JSON.stringify(counterFile)};
const count = existsSync(counterFile) ? parseInt(readFileSync(counterFile, "utf8")) : 0;
writeFileSync(counterFile, String(count + 1));
const isOldGreen = count === 0;
const proc = spawn(process.execPath, [tsx, main, "--serve", "0", "--no-tui"], {
  cwd: process.cwd(),
  stdio: ["inherit", "pipe", "pipe", "ipc"],
  env: { ...process.env, ALEF_SCRIPTED_REPLIES: JSON.stringify(["ok"]), TSX_TSCONFIG_PATH: tsconfig, ALEF_SUPERVISOR: "1" },
});
proc.stdout.pipe(process.stdout);
proc.stderr.pipe(process.stderr);
process.on("message", (msg) => {
  // Old green drops handoff_prepare instead of forwarding it.
  const m = msg;
  if (isOldGreen && m && m.type === "handoff_prepare") return;
  if (proc.connected) proc.send(msg);
});
proc.on("message", (msg) => { if (process.connected) process.send(msg); });
proc.on("exit", (code) => process.exit(code ?? 0));
process.on("SIGTERM", () => proc.kill("SIGTERM"));
if (isOldGreen) {
  let triggered = false, buf = "";
  proc.stderr.on("data", (chunk) => {
    buf += chunk.toString();
    if (!triggered && buf.includes("router listening on")) {
      triggered = true;
      if (typeof process.send === "function") process.send({ type: "rebuild" });
    }
  });
}
`,
			"utf-8",
		);

		const supervisor = spawn(process.execPath, [TSX, SUPERVISOR], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				ALEF_SUPERVISOR_GREEN_SCRIPT: greenScript,
				ALEF_SUPERVISOR_BUILD_COMMAND: `${process.execPath} -e "process.exit(0)"`,
				ALEF_SUPERVISOR_SKIP_HEALTH: "1",
				ALEF_SUPERVISOR_AUTO_REBUILD_ON_START: "0",
				TSX_TSCONFIG_PATH: TSCONFIG,
			},
		});

		try {
			await waitForOutput(supervisor, /router listening on/, 25_000);
			// Supervisor must promote despite missing ack (5s handoff timeout + new green boot).
			await waitForOutput(supervisor, /Promoted staging slot/, 30_000);
		} finally {
			supervisor.kill("SIGTERM");
		}
	}, 70_000);

	// ALE-TSK-358: scope:packages triggers alef-pm upgrade without crashing supervisor.
	it("scope:packages update — supervisor calls alef-pm.upgrade() and rebuilds", async () => {
		const cwd = makeTmp();
		const greenScript = join(cwd, "green.mjs");

		// Green sends { type: "update", scope: "packages" } once it is ready.
		writeSelfTriggerGreen(
			greenScript,
			`
let pkgTriggered = false;
let pkgBuf = "";
proc.stderr.on("data", (chunk) => {
  pkgBuf += chunk.toString();
  if (!pkgTriggered && pkgBuf.includes("router listening on")) {
    pkgTriggered = true;
    if (typeof process.send === "function") process.send({ type: "update", scope: "packages" });
  }
});
`,
		);

		const supervisor = spawn(process.execPath, [TSX, SUPERVISOR], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				ALEF_SUPERVISOR_GREEN_SCRIPT: greenScript,
				ALEF_SUPERVISOR_BUILD_COMMAND: `${process.execPath} -e "process.exit(0)"`,
				ALEF_SUPERVISOR_SKIP_HEALTH: "1",
				ALEF_SUPERVISOR_AUTO_REBUILD_ON_START: "0",
				ALEF_PM_SKIP_NPM: "1",
				ALEF_PM_ROOT: cwd,
				TSX_TSCONFIG_PATH: TSCONFIG,
			},
		});

		try {
			await waitForOutput(supervisor, /router listening on/, 25_000);
			// Supervisor logs the scope:packages path and proceeds to rebuild.
			await waitForOutput(supervisor, /upgrading organs/, 15_000);
		} finally {
			supervisor.kill("SIGTERM");
		}
	}, 55_000);
});
