/**
 * E2E real-LLM tests for the runner HTTP surface.
 *
 * POST /message → SSE reply with real LLM
 * Blueprint organ selection verified with real LLM
 * RouterOrgan SSE filter with real LLM
 *
 * Gate: ANTHROPIC_API_KEY or ANTHROPIC_VERTEX_PROJECT_ID must be set.
 * Default model: claude-haiku-4-5 (cheapest, fast enough).
 * Override: ALEF_E2E_MODEL=claude-sonnet-4-5
 *
 * Design principles:
 * - One SSE connection per test (no racing collectors).
 * - Unguessable file content forces actual tool use — a model can't
 * answer correctly without reading the file.
 * - JSONL records are the ground truth for tool usage; SSE is the
 * surface under test.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import { homedir, tmpdir } from "node:os";
import { join, resolve as pathResolve } from "node:path";
import { afterEach, describe, expect, it, onTestFailed } from "vitest";
import type { StorageRecord } from "../../runner/src/session-store.js";
import {
	assertFileReadWorkflow,
	assertHashesPresent,
	assertMultiTurnHistory,
	assertOrganSelection,
	assertSseFilter,
	assertSubagentWorkflow,
	assertToolSequence,
} from "../../runner/test/e2e-verifiers.js";

// ---------------------------------------------------------------------------
// Debug collector — dumps full event log on test failure (Orange instrumentation)
// ---------------------------------------------------------------------------

interface TestDebugState {
	runnerOutput: string;
	sseEvents: unknown[];
	postedMessages: string[];
}

let debug: TestDebugState = { runnerOutput: "", sseEvents: [], postedMessages: [] };

function resetDebug(): void {
	debug = { runnerOutput: "", sseEvents: [], postedMessages: [] };
}

/** Call at the start of each test. Registers an onTestFailed dump. */
function withDebugDump(): void {
	resetDebug();
	onTestFailed(() => {
		process.stderr.write("\n");
		process.stderr.write("╔══ E2E FAILURE DUMP ═══════════════════════════════════╗\n");
		process.stderr.write(`║ model: ${E2E_MODEL}\n`);
		process.stderr.write("╠══ Runner output ════════════════════════════════════════╣\n");
		for (const line of debug.runnerOutput.split("\n")) {
			if (line.trim()) process.stderr.write(` ${line}\n`);
		}
		process.stderr.write("╠══ Posted messages ══════════════════════════════════════╣\n");
		for (const m of debug.postedMessages) {
			process.stderr.write(` POST /message: ${m}\n`);
		}
		process.stderr.write("╠══ SSE events (all) ═════════════════════════════════════╣\n");
		if (debug.sseEvents.length === 0) {
			process.stderr.write(" (none)\n");
		} else {
			for (const ev of debug.sseEvents) {
				const e = ev as { bus?: string; type?: string; payload?: unknown; timestamp?: number };
				const ts = e.timestamp ? new Date(e.timestamp).toISOString().slice(11, 23) : "?";
				const payload = JSON.stringify(e.payload).slice(0, 120);
				process.stderr.write(` [${ts}] ${e.bus}/${e.type} ${payload}\n`);
			}
		}
		process.stderr.write("╚═════════════════════════════════════════════════════════╝\n");
	});
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

const HAVE_LLM =
	(Boolean(process.env.ANTHROPIC_API_KEY) || Boolean(process.env.ANTHROPIC_VERTEX_PROJECT_ID)) &&
	Boolean(process.env.ALEF_E2E_TESTS);

// Model selection: ALEF_EVAL_MODEL → ALEF_MODEL → runner's own DEFAULT_MODEL.
// Set via env var; the runner resolves its default in args.ts.
const E2E_MODEL = process.env.ALEF_EVAL_MODEL ?? process.env.ALEF_MODEL;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const ROOT = pathResolve(__dirname, "../../..");
const TSX = pathResolve(ROOT, "node_modules/tsx/dist/cli.mjs");
const RUNNER_MAIN = pathResolve(__dirname, "../../runner/src/main.ts");
const TSCONFIG = pathResolve(ROOT, "tsconfig.json");

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];
const procs: ChildProcess[] = [];

afterEach(async () => {
	for (const p of procs.splice(0)) {
		if (!p.killed) p.kill("SIGTERM");
		await new Promise<void>((r) => {
			p.once("exit", r);
			setTimeout(r, 1500);
		});
	}
	for (const d of tempDirs.splice(0)) {
		rmSync(d, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmp(): string {
	const d = mkdtempSync(join(tmpdir(), "alef-e2e-real-"));
	tempDirs.push(d);
	return d;
}

/** Spawn runner. Captures all stdout/stderr into debug.runnerOutput. */
async function bootRunner(
	cwd: string,
	extraArgs: string[] = [],
	extraEnv: Record<string, string> = {},
): Promise<{ proc: ChildProcess; baseUrl: string }> {
	return new Promise((resolve, reject) => {
		const proc = spawn(
			process.execPath,
			[TSX, RUNNER_MAIN, "--serve", "0", "--no-tui", ...(E2E_MODEL ? ["--model", E2E_MODEL] : []), ...extraArgs],
			{
				cwd,
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, TSX_TSCONFIG_PATH: TSCONFIG, ...extraEnv },
			},
		);
		procs.push(proc);

		let buf = "";
		let resolved = false;
		// Single persistent listener: feeds debug.runnerOutput for the full lifetime
		// of the process AND detects the bind address. Never removed after bind.
		const onData = (chunk: Buffer) => {
			const text = chunk.toString();
			buf += text;
			debug.runnerOutput += text;
			if (!resolved) {
				const m = buf.match(/router listening on (http:\/\/[\d.]+:\d+)/);
				if (m) {
					resolved = true;
					clearTimeout(timer);
					resolve({ proc, baseUrl: m[1] });
				}
			}
		};
		const timer = setTimeout(() => reject(new Error(`Runner did not bind within 30s\n${buf.slice(-500)}`)), 30_000);
		proc.stdout?.on("data", onData);
		proc.stderr?.on("data", onData);
		proc.on("exit", (code) => {
			clearTimeout(timer);
			reject(new Error(`Runner exited (${code}) before binding\n${buf.slice(-500)}`));
		});
	});
}

/** POST JSON, return { status, json }. */
function postJson(url: string, body: unknown): Promise<{ status: number; json: unknown }> {
	debug.postedMessages.push(JSON.stringify(body));
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

/**
 * Open one SSE connection and accumulate events.
 * Returns { stop, events } — call stop() to close the stream.
 */
function openSse(baseUrl: string): { events: unknown[]; stop: () => void } {
	const events: unknown[] = [];
	let req: http.ClientRequest | null = null;
	let res: http.IncomingMessage | null = null;
	let buf = "";

	req = http.get(`${baseUrl}/events`, (r) => {
		res = r;
		r.on("data", (chunk: Buffer) => {
			buf += chunk.toString();
			const frames = buf.split("\n\n");
			buf = frames.pop() ?? "";
			for (const frame of frames) {
				const line = frame.split("\n").find((l) => l.startsWith("data: "));
				if (!line) continue;
				try {
					const ev = JSON.parse(line.slice(6));
					events.push(ev);
					debug.sseEvents.push(ev); // feed debug collector
				} catch {
					/* skip malformed frame */
				}
			}
		});
		r.on("error", () => {
			/* ignore connection close */
		});
	});
	req.on("error", () => {
		/* ignore */
	});

	return {
		events,
		stop: () => {
			try {
				res?.destroy();
				req?.destroy();
			} catch {
				/* ignore */
			}
		},
	};
}

/** Wait until predicate(events) returns true, or timeout. */
async function waitFor(
	events: unknown[],
	predicate: (events: unknown[]) => boolean,
	timeoutMs = 90_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate(events)) return;
		await new Promise((r) => setTimeout(r, 300));
	}
	throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

/** Read latest JSONL session records from cwd. */
/**
 * Sessions are stored in ~/.alef/sessions/<cwdHash>/ not in the cwd.
 * The hash matches what SessionStore uses (sha1 of cwd, first 12 hex chars).
 */
function readJSONL(cwd: string): StorageRecord[] {
	const cwdHash = createHash("sha1").update(cwd).digest("hex").slice(0, 12);
	const sessionsDir = join(homedir(), ".alef", "sessions", cwdHash);
	let latest = "";
	let latestMtime = 0;
	try {
		for (const file of readdirSync(sessionsDir)) {
			if (!file.endsWith(".jsonl")) continue;
			const fp = join(sessionsDir, file);
			const { mtimeMs } = statSync(fp);
			if (mtimeMs > latestMtime) {
				latestMtime = mtimeMs;
				latest = fp;
			}
		}
	} catch {
		return [];
	}
	if (!latest) return [];
	return readFileSync(latest, "utf-8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as StorageRecord);
}

// ---------------------------------------------------------------------------
// Canary — simplest possible real-LLM health check.
//
// Sends "Hello" through the full stack (runner boot → HTTP → real LLM → SSE).
// A non-empty reply proves the entire pipeline is functional.
// This test would have caught the silent-error regression immediately.
// ---------------------------------------------------------------------------

describe.skipIf(!HAVE_LLM)("canary: full-stack real-LLM health check", { tags: ["canary"] }, () => {
	it("agent replies to 'Hello' with a non-empty response", async () => {
		withDebugDump();
		const cwd = makeTmp();

		const { baseUrl } = await bootRunner(cwd);
		await new Promise((r) => setTimeout(r, 300));

		const sse = openSse(baseUrl);
		await new Promise((r) => setTimeout(r, 100));

		await postJson(`${baseUrl}/message`, { text: "Hello" });

		await waitFor(
			sse.events,
			(evs) =>
				evs.some((ev) => {
					const e = ev as { bus?: string; type?: string; payload?: { text?: string } };
					return e.bus === "motor" && e.type === "llm.response" && Boolean(e.payload?.text?.trim());
				}),
			60_000,
		);

		sse.stop();

		const reply = sse.events.find((ev) => {
			const e = ev as { bus?: string; type?: string; payload?: { text?: string } };
			return e.bus === "motor" && e.type === "llm.response";
		}) as { payload: { text: string } } | undefined;

		expect(reply).toBeDefined();
		expect(reply!.payload.text.trim().length).toBeGreaterThan(0);
	}, 90_000);
});

// ---------------------------------------------------------------------------
// TSK-184: POST /message → SSE → JSONL with real LLM
// ---------------------------------------------------------------------------

describe.skipIf(!HAVE_LLM)("POST /message delivers reply via SSE and persists to JSONL", { tags: ["real-llm"] }, () => {
	it("agent reads a file and reply appears on SSE", async () => {
		withDebugDump();
		const cwd = makeTmp();

		// Unguessable content — the agent cannot answer correctly without reading.
		const secret = randomUUID();
		writeFileSync(join(cwd, "secret.txt"), `The secret code is: ${secret}\n`, "utf-8");

		const { baseUrl } = await bootRunner(cwd);
		await new Promise((r) => setTimeout(r, 300));

		const sse = openSse(baseUrl);
		await new Promise((r) => setTimeout(r, 100));

		await postJson(`${baseUrl}/message`, {
			text: "Read secret.txt and tell me the secret code. You must read the file.",
		});

		// Wait for agent reply on SSE.
		await waitFor(
			sse.events,
			(evs) =>
				evs.some((ev) => {
					const e = ev as { bus?: string; type?: string; payload?: { text?: string } };
					return e.bus === "motor" && e.type === "llm.response" && Boolean(e.payload?.text);
				}),
			90_000,
		);

		sse.stop();

		const replyEvent = sse.events.find((ev) => {
			const e = ev as { bus?: string; type?: string; payload?: { text?: string } };
			return e.bus === "motor" && e.type === "llm.response" && Boolean(e.payload?.text);
		}) as { payload: { text: string } } | undefined;
		expect(replyEvent).toBeDefined();

		await new Promise((r) => setTimeout(r, 300));
		const records = readJSONL(cwd);

		assertFileReadWorkflow(records, replyEvent!.payload.text, secret);
		assertHashesPresent(records);
		assertToolSequence(records, ["fs.read"]);
	}, 120_000);

	it("multi-turn: second reply references content from first turn", async () => {
		withDebugDump();
		const cwd = makeTmp();

		const code = randomUUID().slice(0, 8).toUpperCase();
		writeFileSync(join(cwd, "code.txt"), `ACCESS_CODE=${code}\n`, "utf-8");

		const { baseUrl } = await bootRunner(cwd);
		await new Promise((r) => setTimeout(r, 300));

		const sse = openSse(baseUrl);
		await new Promise((r) => setTimeout(r, 100));

		// Turn 1.
		await postJson(`${baseUrl}/message`, { text: "Read code.txt and tell me the access code." });

		let replyCount = 0;
		await waitFor(
			sse.events,
			(evs) => {
				const replies = evs.filter((ev) => {
					const e = ev as { bus?: string; type?: string; payload?: { text?: string } };
					return e.bus === "motor" && e.type === "llm.response" && Boolean(e.payload?.text);
				});
				if (replies.length > replyCount) {
					replyCount = replies.length;
					return true;
				}
				return false;
			},
			90_000,
		);

		const firstReply = sse.events
			.filter((ev) => {
				const e = ev as { bus?: string; type?: string; payload?: { text?: string } };
				return e.bus === "motor" && e.type === "llm.response";
			})
			.at(-1) as { payload: { text: string } } | undefined;
		expect(firstReply).toBeDefined();

		// Turn 2 — agent should recall from history.
		const prevCount = sse.events.filter((ev) => {
			const e = ev as { bus?: string; type?: string };
			return e.bus === "motor" && e.type === "llm.response";
		}).length;

		// Small gap to ensure turn 1 is fully settled before sending turn 2.
		await new Promise((r) => setTimeout(r, 500));
		await postJson(`${baseUrl}/message`, { text: "What was the access code you just told me?" });
		await waitFor(
			sse.events,
			(evs) =>
				evs.filter((ev) => {
					const e = ev as { bus?: string; type?: string };
					return e.bus === "motor" && e.type === "llm.response";
				}).length > prevCount,
			120_000,
		);

		sse.stop();

		const secondReply = sse.events
			.filter((ev) => {
				const e = ev as { bus?: string; type?: string; payload?: { text?: string } };
				return e.bus === "motor" && e.type === "llm.response";
			})
			.at(-1) as { payload: { text: string } } | undefined;
		expect(secondReply).toBeDefined();

		assertMultiTurnHistory(firstReply!.payload.text, secondReply!.payload.text, code);
	}, 180_000);
});

// ---------------------------------------------------------------------------
// E2E-subagent: outer LLM delegates to a subagent via agent.run
// ---------------------------------------------------------------------------

describe.skipIf(!HAVE_LLM)(
	"subagent delegation: outer LLM delegates task via agent.run",
	{ tags: ["real-llm"] },
	() => {
		it("outer agent calls agent.run(explore), inner agent reads file, secret reaches reply", async () => {
			withDebugDump();
			const cwd = makeTmp();

			// Unguessable content — the reply can only be correct if the inner agent actually read the file.
			const secret = randomUUID();
			writeFileSync(join(cwd, "secret.txt"), `The secret code is: ${secret}\n`, "utf-8");

			const { baseUrl } = await bootRunner(cwd);
			await new Promise((r) => setTimeout(r, 300));

			const sse = openSse(baseUrl);
			await new Promise((r) => setTimeout(r, 100));

			await postJson(`${baseUrl}/message`, {
				text:
					`There is a file called secret.txt in the current directory. ` +
					`You MUST use the agent.run tool with profile 'explore' to delegate reading this file to a subagent. ` +
					`Do not read the file directly yourself. ` +
					`Have the subagent read secret.txt and report the secret code back to you, then tell me the secret code.`,
			});

			await waitFor(
				sse.events,
				(evs) =>
					evs.some((ev) => {
						const e = ev as { bus?: string; type?: string; payload?: { text?: string } };
						return e.bus === "motor" && e.type === "llm.response" && Boolean(e.payload?.text);
					}),
				120_000,
			);

			sse.stop();

			const replyEvent = sse.events.find((ev) => {
				const e = ev as { bus?: string; type?: string; payload?: { text?: string } };
				return e.bus === "motor" && e.type === "llm.response" && Boolean(e.payload?.text);
			}) as { payload: { text: string } } | undefined;
			expect(replyEvent).toBeDefined();

			await new Promise((r) => setTimeout(r, 300));
			const records = readJSONL(cwd);

			assertSubagentWorkflow(records, replyEvent!.payload.text, secret);
		}, 180_000);
	},
);

// ---------------------------------------------------------------------------
// TSK-185: Blueprint organ selection — real LLM only calls permitted tools
// ---------------------------------------------------------------------------

describe.skipIf(!HAVE_LLM)(
	"blueprint organ selection: LLM uses organs specified in blueprint",
	{ tags: ["real-llm"] },
	() => {
		it("agent with fs-only blueprint reads file and makes no lector/shell calls", async () => {
			withDebugDump();
			const cwd = makeTmp();

			const secret = randomUUID();
			writeFileSync(join(cwd, "data.txt"), `value=${secret}\n`, "utf-8");

			writeFileSync(join(cwd, "agent.yaml"), ["name: fs-only-agent", "organs:", " - name: fs"].join("\n"), "utf-8");

			const { baseUrl } = await bootRunner(cwd, ["--blueprint", join(cwd, "agent.yaml")]);
			await new Promise((r) => setTimeout(r, 300));

			const sse = openSse(baseUrl);
			await new Promise((r) => setTimeout(r, 100));

			await postJson(`${baseUrl}/message`, {
				text: "Read data.txt and tell me the value. You must read the file.",
			});

			await waitFor(
				sse.events,
				(evs) =>
					evs.some((ev) => {
						const e = ev as { bus?: string; type?: string; payload?: { text?: string } };
						return e.bus === "motor" && e.type === "llm.response" && Boolean(e.payload?.text);
					}),
				90_000,
			);
			sse.stop();

			const reply = sse.events.find((ev) => {
				const e = ev as { bus?: string; type?: string; payload?: { text?: string } };
				return e.bus === "motor" && e.type === "llm.response";
			}) as { payload: { text: string } } | undefined;
			expect(reply).toBeDefined();

			await new Promise((r) => setTimeout(r, 300));
			const records = readJSONL(cwd);

			assertFileReadWorkflow(records, reply!.payload.text, secret);
			assertOrganSelection(records, ["fs.read"], ["lector.", "shell."]);
		}, 120_000);
	},
);

// ---------------------------------------------------------------------------
// TSK-187: RouterOrgan SSE filter with real LLM
// ---------------------------------------------------------------------------

describe.skipIf(!HAVE_LLM)(
	"SSE event filter: RouterOrgan delivers only allowed event types",
	{ tags: ["real-llm"] },
	() => {
		it("filtered surface blocks fs.read events but passes llm.response", async () => {
			withDebugDump();
			const cwd = makeTmp();
			const secret = randomUUID();
			writeFileSync(join(cwd, "filter-test.txt"), `secret=${secret}\n`, "utf-8");

			// Blueprint: only dialog.message passes through SSE.
			writeFileSync(
				join(cwd, "agent.yaml"),
				[
					"name: filtered-agent",
					"organs:",
					" - name: fs",
					"surfaces:",
					" - type: sse",
					" events:",
					" - llm.response",
				].join("\n"),
				"utf-8",
			);

			const { baseUrl } = await bootRunner(cwd, ["--blueprint", join(cwd, "agent.yaml")]);
			await new Promise((r) => setTimeout(r, 300));

			const sse = openSse(baseUrl);
			await new Promise((r) => setTimeout(r, 100));

			await postJson(`${baseUrl}/message`, {
				text: "Read filter-test.txt and tell me the secret value. You must use a tool.",
			});

			// Wait for the agent reply.
			await waitFor(
				sse.events,
				(evs) =>
					evs.some((ev) => {
						const e = ev as { bus?: string; type?: string; payload?: { text?: string } };
						return e.bus === "motor" && e.type === "llm.response" && Boolean(e.payload?.text);
					}),
				90_000,
			);
			sse.stop();

			await new Promise((r) => setTimeout(r, 300));
			const records = readJSONL(cwd);
			const sseTypes = sse.events.map((ev) => (ev as { type?: string }).type ?? "");

			assertSseFilter(sseTypes, new Set(records.map((r) => r.type)), ["llm.response"], ["fs.read"]);
		}, 120_000);
	},
);
