/**
 * Black-box smoke test — spawns the installed 'alef' binary (or falls back to
 * the source entry via tsx) and verifies the full request/reply cycle without
 * a real LLM, using ALEF_SCRIPTED_REPLIES.
 *
 * This is the "can I actually use it?" gate. If this passes, the binary is
 * wired correctly end-to-end: args parsing, organ boot, HTTP surface, SSE,
 * message routing, reply delivery.
 *
 * Does NOT require an API key.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve as pathResolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Binary resolution — prefer the installed 'alef', fall back to source
// ---------------------------------------------------------------------------

function findAlef(): { bin: string; args: string[] } {
	// Always use tsx + source — avoids stale global install during development.
	// The smoke test proves the entry point, arg parsing, and HTTP surface.
	const root = pathResolve(__dirname, "../../..");
	const tsx = pathResolve(root, "node_modules/tsx/dist/cli.mjs");
	const main = pathResolve(__dirname, "../src/main.ts");
	const tsconfig = pathResolve(root, "tsconfig.json");
	process.env.TSX_TSCONFIG_PATH = tsconfig;
	return { bin: process.execPath, args: [tsx, main] };
}

const { bin, args: binArgs } = findAlef();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const procs: ChildProcess[] = [];
const tmps: string[] = [];

afterEach(async () => {
	for (const p of procs.splice(0)) {
		if (!p.killed) p.kill("SIGTERM");
		await new Promise<void>((r) => {
			p.once("exit", r);
			setTimeout(r, 2000);
		});
	}
	for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeTmp(): string {
	const d = mkdtempSync(join(tmpdir(), "alef-smoke-"));
	tmps.push(d);
	return d;
}

function bootAlef(
	cwd: string,
	replies: (string | object)[],
	extraArgs: string[] = [],
): Promise<{ proc: ChildProcess; baseUrl: string }> {
	return new Promise((resolve, reject) => {
		const proc = spawn(bin, [...binArgs, "--serve", "0", "--no-tui", ...extraArgs], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				ALEF_SCRIPTED_REPLIES: JSON.stringify(replies),
			},
		});
		procs.push(proc);

		let buf = "";
		const timer = setTimeout(() => reject(new Error(`alef did not bind within 25s\n${buf.slice(-300)}`)), 25_000);

		const onData = (chunk: Buffer) => {
			buf += chunk.toString();
			const m = buf.match(/router listening on (http:\/\/[\d.]+:\d+)/);
			if (m) {
				clearTimeout(timer);
				resolve({ proc, baseUrl: m[1] });
			}
		};
		proc.stdout?.on("data", onData);
		proc.stderr?.on("data", onData);
		proc.on("exit", (code) => {
			clearTimeout(timer);
			reject(new Error(`alef exited (${code}) before binding\n${buf.slice(-300)}`));
		});
	});
}

function getJson(url: string): Promise<unknown> {
	return new Promise((resolve, reject) => {
		http
			.get(url, (res) => {
				let raw = "";
				res.on("data", (c: Buffer) => {
					raw += c.toString();
				});
				res.on("end", () => {
					try {
						resolve(JSON.parse(raw));
					} catch {
						resolve(raw);
					}
				});
			})
			.on("error", reject);
	});
}

function postJson(url: string, body: unknown): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const data = JSON.stringify(body);
		const u = new URL(url);
		const req = http.request(
			{
				hostname: u.hostname,
				port: Number(u.port),
				path: u.pathname,
				method: "POST",
				headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
			},
			(res) => {
				let r = "";
				res.on("data", (c: Buffer) => {
					r += c.toString();
				});
				res.on("end", () => {
					try {
						resolve(JSON.parse(r));
					} catch {
						resolve(r);
					}
				});
			},
		);
		req.on("error", reject);
		req.write(data);
		req.end();
	});
}

function collectReply(baseUrl: string, expected: string, timeoutMs = 15_000): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`Timed out waiting for reply: "${expected}"`)), timeoutMs);
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
							const ev = JSON.parse(line.slice(6)) as {
								bus?: string;
								type?: string;
								payload?: { text?: string };
							};
							if (ev.bus === "motor" && ev.type === "dialog.message" && ev.payload?.text === expected) {
								clearTimeout(timer);
								res.destroy();
								resolve();
							}
						} catch {}
					}
				});
			})
			.on("error", reject);
	});
}

/**
 * Collect all SSE events until a dialog.message reply matching `expected` arrives.
 * Resolves with the full event list so callers can inspect intermediate events.
 */
function collectEventsUntilReply(baseUrl: string, expected: string, timeoutMs = 15_000): Promise<unknown[]> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`Timed out waiting for reply: "${expected}"`)), timeoutMs);
		const events: unknown[] = [];
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
							events.push(ev);
							const e = ev as { bus?: string; type?: string; payload?: { text?: string } };
							if (e.bus === "motor" && e.type === "dialog.message" && e.payload?.text === expected) {
								clearTimeout(timer);
								res.destroy();
								resolve(events);
							}
						} catch {}
					}
				});
			})
			.on("error", reject);
	});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("alef binary smoke tests (no real LLM)", { tags: ["integration"] }, () => {
	it("boots and responds to GET /health", async () => {
		const cwd = makeTmp();
		const { baseUrl } = await bootAlef(cwd, ["ping"]);

		const health = (await getJson(`${baseUrl}/health`)) as { ok: boolean };
		expect(health.ok).toBe(true);
	}, 30_000);

	it("POST /message → scripted reply appears on SSE", async () => {
		const cwd = makeTmp();
		const { baseUrl } = await bootAlef(cwd, ["pong"]);

		const replyPromise = collectReply(baseUrl, "pong");
		await new Promise((r) => setTimeout(r, 100));

		await postJson(`${baseUrl}/message`, { text: "ping" });
		await replyPromise;
	}, 30_000);

	it("ping-pong round-trip: send message, get reply, send again", async () => {
		const cwd = makeTmp();
		const { baseUrl } = await bootAlef(cwd, ["first reply", "second reply"]);

		const first = collectReply(baseUrl, "first reply");
		await new Promise((r) => setTimeout(r, 100));
		await postJson(`${baseUrl}/message`, { text: "turn 1" });
		await first;

		const second = collectReply(baseUrl, "second reply");
		await new Promise((r) => setTimeout(r, 300));
		await postJson(`${baseUrl}/message`, { text: "turn 2" });
		await second;
	}, 45_000);

	it("agent.run is present in the tool catalog — organ-delegate is mounted on boot", async () => {
		// Script the LLM to call tools.describe([]) — returns all tool names in its sense payload.
		// If organ-delegate is not mounted, agent.run is absent from the catalog.
		// No real LLM needed; no inner-agent network call.
		const cwd = makeTmp();
		const replies = [
			{ kind: "toolCall", call: { name: "tools.describe", args: { names: [] } }, reply: "catalog-ok" },
		];
		const { baseUrl } = await bootAlef(cwd, replies);
		await new Promise((r) => setTimeout(r, 100));

		const eventsPromise = collectEventsUntilReply(baseUrl, "catalog-ok");
		await postJson(`${baseUrl}/message`, { text: "list tools" });
		const events = await eventsPromise;

		// Find the sense/tools.describe event carrying the catalog payload.
		const catalogEvent = events.find((ev) => {
			const e = ev as { bus?: string; type?: string };
			return e.bus === "sense" && e.type === "tools.describe";
		}) as { payload?: { result?: Array<{ name: string }> } } | undefined;

		expect(catalogEvent, "sense/tools.describe must appear in SSE").toBeDefined();
		const results = ((catalogEvent?.payload as Record<string, unknown>)?.results ?? []) as Array<{ name: string }>;
		const toolNames = results.map((t) => t.name);
		expect(toolNames, "agent.run must be in the tool catalog — organ-delegate must be mounted").toContain(
			"agent.run",
		);
	}, 30_000);

	it("--print mode exits cleanly with scripted reply on stdout", async () => {
		const cwd = makeTmp();
		await new Promise<void>((resolve, reject) => {
			let out = "";
			const proc = spawn(bin, [...binArgs, "--print", "hello"], {
				cwd,
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, ALEF_SCRIPTED_REPLIES: JSON.stringify(["world"]) },
			});
			proc.stdout?.on("data", (c: Buffer) => {
				out += c.toString();
			});
			proc.stderr?.on("data", (c: Buffer) => {
				out += c.toString();
			});
			proc.on("exit", (code) => {
				if (code !== 0) return reject(new Error(`exit ${code}\n${out}`));
				if (!out.includes("world")) return reject(new Error(`Reply not in output:\n${out}`));
				resolve();
			});
			setTimeout(() => {
				proc.kill();
				reject(new Error("Timed out"));
			}, 20_000);
		});
	}, 25_000);
});
