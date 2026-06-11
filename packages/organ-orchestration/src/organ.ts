/**
 * OrchestrationOrgan — child-Alef lifecycle management and task delegation.
 *
 * Tools:
 *   orchestration.spawn   — start a child Alef, return endpoint + sessionId
 *   orchestration.ask     — delegate a prompt to a child and return its reply (EIP Request-Reply)
 *   orchestration.kill    — stop a named child
 *   orchestration.list    — enumerate running children
 *   orchestration.status  — health-check a named child
 *   orchestration.promote — add an organ to the production blueprint, trigger blue-green
 *
 * The organ owns the Map<name, ChildEntry> and kills all children on unmount.
 * promote() fires process.send({ type: "rebuild" }) when running under supervisor.ts
 * (ALEF_SUPERVISOR=1), triggering the blue-green IPC loop.
 */

import { type ChildProcess, execSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { homedir, tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import type { ExecutionStrategy, Organ, OrganLogger } from "@dpopsuev/alef-kernel";
import { defineOrgan, typedAction, Watchdog, withDisplay } from "@dpopsuev/alef-kernel";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { RemoteProcessStrategy } from "./remote-process.js";
import type { ChildEntry } from "./types.js";

function detectBwrap(): string | null {
	try {
		const path = execSync("which bwrap", { stdio: ["ignore", "pipe", "ignore"] })
			.toString()
			.trim();
		return path || null;
	} catch {
		return null;
	}
}

const BWRAP_PATH = detectBwrap();

function wrapWithBwrap(cmd: string[]): [string, string[]] {
	if (!BWRAP_PATH) throw new Error("sandbox: true requires bwrap (bubblewrap) — not found on PATH");
	const bwrapArgs = [
		"--ro-bind",
		"/",
		"/",
		"--dev",
		"/dev",
		"--proc",
		"/proc",
		"--tmpfs",
		"/tmp",
		"--unshare-net",
		"--die-with-parent",
		"--",
		...cmd,
	];
	return [BWRAP_PATH, bwrapArgs];
}

export interface OrchestrationOrganOptions {
	/** Working directory for child Alef processes. Defaults to process.cwd(). */
	cwd?: string;
	/** Timeout in ms waiting for a child to become ready. Default: 30_000. */
	readinessTimeoutMs?: number;
	logger?: OrganLogger;
	/**
	 * Called after a child spawns successfully with a RemoteProcessStrategy
	 * bound to that child's endpoint. organ-delegate uses this to register
	 * the child as a named delegation target.
	 */
	onChildReady?: (name: string, strategy: ExecutionStrategy) => void;
	/** Event type to wait for as the child's reply. Provided by assembly. */
	replyEvent: string;
}

const RUNNER_MAIN = new URL("../../runner/src/main.ts", import.meta.url).pathname;
const TSX_BIN = new URL("../../../node_modules/.bin/tsx", import.meta.url).pathname;

function resolvePath(p: string, base: string): string {
	return isAbsolute(p) ? p : resolve(base, p);
}

function waitForReady(
	child: ChildProcess,
	timeoutMs: number,
): Promise<{ endpoint: string; sessionId: string | undefined }> {
	return new Promise((resolveP, rejectP) => {
		let endpoint = "";
		let sessionId: string | undefined;
		const stderrLines: string[] = [];
		// lint-ignore: RAWTIMER child readiness one-shot deadline
		const timer = setTimeout(() => rejectP(new Error("Child readiness timeout")), timeoutMs);

		const scan = (chunk: Buffer | string) => {
			const text = typeof chunk === "string" ? chunk : chunk.toString();
			const sessionMatch = text.match(/\[session\]\s+(\S+)/);
			if (sessionMatch) sessionId = sessionMatch[1];
			const routerMatch = text.match(/router listening on (http:\/\/[\d.]+:\d+)/);
			if (routerMatch) {
				endpoint = routerMatch[1];
				clearTimeout(timer);
				child.stdout?.off("data", scan);
				child.stderr?.off("data", scanStderr);
				resolveP({ endpoint, sessionId });
			}
		};

		const scanStderr = (chunk: Buffer | string) => {
			const text = typeof chunk === "string" ? chunk : chunk.toString();
			stderrLines.push(text);
			scan(chunk);
		};

		child.stdout?.on("data", scan);
		child.stderr?.on("data", scanStderr);
		child.once("exit", (code) => {
			clearTimeout(timer);
			const detail = stderrLines.length > 0 ? `\n${stderrLines.join("").trim()}` : "";
			rejectP(new Error(`Child exited (${code}) before ready${detail}`));
		});
	});
}

function healthCheck(endpoint: string): Promise<boolean> {
	return new Promise((res) => {
		http.get(`${endpoint}/health`, (resp) => res(resp.statusCode === 200)).on("error", () => res(false));
	});
}

export function createOrchestrationOrgan(opts: OrchestrationOrganOptions): Organ {
	const cwd = opts.cwd ?? process.cwd();
	const readinessTimeoutMs = opts.readinessTimeoutMs ?? 30_000;
	const children = new Map<string, ChildEntry>();
	let childSeq = 0;
	let mountedNerve: import("@dpopsuev/alef-kernel").Nerve | null = null;

	const ASK_TOOL = {
		name: "orchestration.ask",
		description:
			"Send a prompt to a running child Alef and return its reply. " +
			"Blocks until the child replies or goes silent. " +
			"Use after orchestration.spawn to delegate a task and get the result.",
		inputSchema: z.object({
			name: z.string().min(1).describe("Child name from orchestration.spawn"),
			prompt: z.string().min(1).describe("Message to send to the child agent"),
			stallMs: z
				.number()
				.optional()
				.describe(
					"Inactivity threshold in ms — resets on each SSE event (default: 60_000). Child doing long work never times out as long as it emits events.",
				),
			maxMs: z
				.number()
				.optional()
				.describe("Hard wall-clock limit in ms regardless of activity (default: 600_000)."),
		}),
	};

	async function handleAsk(ctx: {
		payload: { name: string; prompt: string; stallMs?: number; maxMs?: number };
	}): Promise<Record<string, unknown>> {
		const { name: childName, prompt, stallMs = 60_000, maxMs = 600_000 } = ctx.payload;
		const entry = children.get(childName);
		if (!entry) throw new Error(`orchestration.ask: no child named '${childName}'`);

		let rejectStall: ((e: Error) => void) | undefined;
		const stallPromise = new Promise<never>((_, reject) => {
			rejectStall = reject;
		});
		const watchdog = new Watchdog(stallMs, () => {
			entry.process.kill("SIGTERM");
			children.delete(childName);
			mountedNerve?.sense.publish({
				type: "child.reaped",
				correlationId: "system",
				isError: false,
				payload: { name: childName, reason: "stall" },
			});
			rejectStall?.(new Error(`orchestration.ask: child '${childName}' stalled — no SSE events for ${stallMs}ms`));
		});
		watchdog.start();

		// lint-ignore: RAWTIMER hard wall-clock cap beyond the stall watchdog
		const hardTimer = setTimeout(() => {
			watchdog.stop();
			rejectStall?.(new Error(`orchestration.ask: child '${childName}' exceeded maxMs (${maxMs}ms)`));
		}, maxMs);

		const strategy = new RemoteProcessStrategy(entry.endpoint, opts.replyEvent, () => watchdog.reset());
		try {
			const reply = await Promise.race([
				strategy.send({ text: prompt, sender: "human", timeoutMs: maxMs }),
				stallPromise,
			]);
			watchdog.stop();
			clearTimeout(hardTimer);
			if (!reply) {
				return withDisplay(
					{ name: childName, reply: null, timedOut: true },
					{ text: `**${childName}** did not reply`, mimeType: "text/markdown" },
				);
			}
			return withDisplay({ name: childName, reply }, { text: reply, mimeType: "text/plain" });
		} catch (err) {
			watchdog.stop();
			clearTimeout(hardTimer);
			throw err;
		}
	}

	const SPAWN_TOOL = {
		name: "orchestration.spawn",
		description:
			"Start a child Alef process. Pass blueprintPath to an existing agent.yaml, or pass organs[] " +
			"with paths to TypeScript organ files (loaded via jiti, no build step). " +
			"Returns { name, endpoint, sessionId, pid } for subsequent orchestration.* calls.",
		inputSchema: z.object({
			blueprintPath: z
				.string()
				.optional()
				.describe("Path to an agent.yaml blueprint. Mutually exclusive with organs[]."),
			organs: z
				.array(z.string().min(1))
				.optional()
				.describe("Paths to .ts organ files. Orchestration organ writes a temp agent.yaml."),
			cwd: z.string().optional().describe("Working directory for the child. Defaults to parent cwd."),
			sessionId: z.string().optional().describe("Resume a previous session by ID."),
			sandbox: z
				.boolean()
				.optional()
				.describe(
					"Wrap child in bubblewrap (bwrap) for filesystem and network namespace isolation. " +
						"Requires bwrap on PATH. Use for externally-sourced or untrusted organs.",
				),
		}),
	};

	async function handleSpawn(ctx: {
		payload: { blueprintPath?: string; organs?: string[]; cwd?: string; sessionId?: string; sandbox?: boolean };
	}): Promise<Record<string, unknown>> {
		const childCwd = ctx.payload.cwd ?? cwd;
		const blueprintPathRaw = ctx.payload.blueprintPath;
		const resumeSession = ctx.payload.sessionId;
		const sandbox = ctx.payload.sandbox ?? false;
		const organPaths: string[] = ctx.payload.organs ?? [];

		let blueprintPath = blueprintPathRaw ? resolvePath(blueprintPathRaw, childCwd) : undefined;
		let tmpDir: string | undefined;

		if (organPaths.length > 0 && !blueprintPath) {
			tmpDir = mkdtempSync(join(tmpdir(), "alef-sup-"));
			blueprintPath = join(tmpDir, "agent.yaml");
			const def = {
				apiVersion: "alef.dpopsuev.io/v1alpha1",
				kind: "AgentRuntime",
				metadata: { name: "staging" },
				spec: {
					organs: organPaths.map((p) => ({ path: resolvePath(p, childCwd) })),
				},
			};
			writeFileSync(blueprintPath, stringifyYaml(def), "utf-8");
		}

		const args = [TSX_BIN, RUNNER_MAIN, "--serve", "0", "--no-tui"];
		if (blueprintPath) args.push("--blueprint", blueprintPath);
		if (resumeSession) args.push("--resume", resumeSession);

		// Organs outside the monorepo tree can't resolve @dpopsuev/* without this.
		const alefNodeModules = new URL("../../../node_modules", import.meta.url).pathname;
		const nodePath = [alefNodeModules, process.env.NODE_PATH].filter(Boolean).join(delimiter);
		const env: NodeJS.ProcessEnv = {
			...process.env,
			ALEF_SUPERVISOR: "1",
			NODE_PATH: nodePath,
			// TSX needs this to resolve path aliases when running the child via tsx.
			// If already in the environment (e.g. monorepo dev), preserve it.
			...(process.env.TSX_TSCONFIG_PATH
				? {}
				: {
						TSX_TSCONFIG_PATH: new URL("../../../tsconfig.json", import.meta.url).pathname,
					}),
		};

		const [spawnCmd, spawnArgs] = sandbox ? wrapWithBwrap([process.execPath, ...args]) : [process.execPath, args];

		const child = spawn(spawnCmd, spawnArgs, {
			cwd: childCwd,
			env,
			stdio: ["ignore", "pipe", "pipe", "ipc"],
		});

		let ready: { endpoint: string; sessionId: string | undefined };
		try {
			ready = await waitForReady(child, readinessTimeoutMs);
		} catch (err) {
			if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
			child.kill("SIGTERM");
			throw err;
		}

		const name = `child-${++childSeq}`;
		const entry: ChildEntry = {
			name,
			endpoint: ready.endpoint,
			sessionId: ready.sessionId,
			pid: child.pid ?? 0,
			process: child,
			startedAt: Date.now(),
		};
		children.set(name, entry);

		const strategy = new RemoteProcessStrategy(ready.endpoint, opts.replyEvent, () => mountedNerve?.pulse());
		opts.onChildReady?.(name, strategy);

		child.once("exit", (code) => {
			children.delete(name);
			if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
			mountedNerve?.sense.publish({
				type: "child.reaped",
				correlationId: "system",
				isError: false,
				payload: { name, reason: "exited", exitCode: code ?? undefined },
			});
		});

		return withDisplay(
			{ name, endpoint: ready.endpoint, sessionId: ready.sessionId ?? "", pid: entry.pid },
			{ text: `Spawned **${name}** (pid ${entry.pid}) at ${ready.endpoint}`, mimeType: "text/markdown" },
		);
	}

	const KILL_TOOL = {
		name: "orchestration.kill",
		description: "Stop a named child Alef process (SIGTERM, then SIGKILL after 3s).",
		inputSchema: z.object({
			name: z.string().min(1).describe("Child name from supervisor.spawn"),
		}),
	};

	async function handleKill(ctx: { payload: { name: string } }): Promise<Record<string, unknown>> {
		const { name: childName } = ctx.payload;
		const entry = children.get(childName);
		if (!entry) return { stopped: false, reason: `no child named '${childName}'` };

		entry.process.kill("SIGTERM");
		await new Promise<void>((res) => {
			// lint-ignore: RAWTIMER SIGKILL escalation after SIGTERM grace period
			const t = setTimeout(() => {
				entry.process.kill("SIGKILL");
				res();
			}, 3_000);
			entry.process.once("exit", () => {
				clearTimeout(t);
				res();
			});
		});
		children.delete(childName);
		return withDisplay(
			{ stopped: true, name: childName },
			{ text: `Stopped **${childName}**`, mimeType: "text/markdown" },
		);
	}

	const LIST_TOOL = {
		name: "orchestration.list",
		description: "List all running child Alef processes with their endpoints and session IDs.",
		inputSchema: z.object({}),
	};

	async function handleList(_ctx: unknown): Promise<Record<string, unknown>> {
		const items = await Promise.all(
			[...children.values()].map(async (e) => ({
				name: e.name,
				endpoint: e.endpoint,
				sessionId: e.sessionId ?? null,
				pid: e.pid,
				uptimeMs: Date.now() - e.startedAt,
				alive: await healthCheck(e.endpoint),
			})),
		);
		const summary =
			items.length === 0
				? "No running children."
				: items.map((c) => `- **${c.name}** pid=${c.pid} ${c.alive ? "✅" : "❌"} ${c.endpoint}`).join("\n");
		return withDisplay({ children: items }, { text: summary, mimeType: "text/markdown" });
	}

	const STATUS_TOOL = {
		name: "orchestration.status",
		description: "Health-check a named child Alef process.",
		inputSchema: z.object({
			name: z.string().min(1).describe("Child name from orchestration.spawn"),
		}),
	};

	async function handleStatus(ctx: { payload: { name: string } }): Promise<Record<string, unknown>> {
		const { name: childName } = ctx.payload;
		const entry = children.get(childName);
		if (!entry) return { alive: false, reason: `no child named '${childName}'` };
		const alive = await healthCheck(entry.endpoint);
		const uptimeMs = Date.now() - entry.startedAt;
		return withDisplay(
			{ name: childName, alive, endpoint: entry.endpoint, sessionId: entry.sessionId ?? null, uptimeMs },
			{
				text: `**${childName}** ${alive ? "✅ alive" : "❌ dead"} — uptime ${Math.round(uptimeMs / 1000)}s`,
				mimeType: "text/markdown",
			},
		);
	}

	const PROMOTE_TOOL = {
		name: "orchestration.promote",
		description:
			"Add a new organ to the production blueprint and trigger a blue-green swap via the supervisor. " +
			"Only fires when running under supervisor.ts (ALEF_SUPERVISOR=1). " +
			"Returns { promoted: true } when the IPC rebuild was sent, { promoted: false } otherwise.",
		inputSchema: z.object({
			organPath: z.string().min(1).describe("Absolute path to the .ts organ file to add to production."),
			blueprintPath: z
				.string()
				.optional()
				.describe(
					"Path to the production blueprint to update. " +
						"Defaults to ALEF_BLUEPRINT_PATH env, then ~/.config/alef/agent.yaml.",
				),
		}),
	};

	function handlePromote(ctx: { payload: { organPath: string; blueprintPath?: string } }): Record<string, unknown> {
		const organPath = resolvePath(ctx.payload.organPath, cwd);
		const blueprintPath = ctx.payload.blueprintPath
			? resolvePath(ctx.payload.blueprintPath, cwd)
			: (process.env.ALEF_BLUEPRINT_PATH ?? join(homedir(), ".config", "alef", "agent.yaml"));

		// Parse, append, write.
		let doc: Record<string, unknown> = {};
		try {
			doc = parseYaml(readFileSync(blueprintPath, "utf-8")) as Record<string, unknown>;
		} catch {
			// Blueprint may not exist yet — start fresh.
		}
		const spec = (doc.spec ?? {}) as Record<string, unknown>;
		const organs = Array.isArray(spec.organs) ? [...spec.organs] : [];
		if (!organs.some((o) => (o as { path?: string }).path === organPath)) {
			organs.push({ path: organPath });
		}
		spec.organs = organs;
		doc.spec = spec;
		writeFileSync(blueprintPath, stringifyYaml(doc), "utf-8");

		// Fire blue-green IPC if running under supervisor.
		const underSupervisor = process.env.ALEF_SUPERVISOR === "1" && typeof process.send === "function";
		if (underSupervisor) {
			process.send?.({ type: "rebuild" });
			return { promoted: true, organPath, blueprintPath };
		}

		return {
			promoted: false,
			reason: "not running under supervisor (ALEF_SUPERVISOR != 1)",
			organPath,
			blueprintPath,
		};
	}

	return defineOrgan(
		"orchestration",
		{
			motor: {
				"orchestration.spawn": typedAction(SPAWN_TOOL, handleSpawn),
				"orchestration.ask": typedAction(ASK_TOOL, handleAsk),
				"orchestration.kill": typedAction(KILL_TOOL, handleKill),
				"orchestration.list": typedAction(LIST_TOOL, handleList),
				"orchestration.status": typedAction(STATUS_TOOL, handleStatus),
				"orchestration.promote": typedAction(PROMOTE_TOOL, async (ctx) => handlePromote(ctx)),
			},
		},
		{
			logger: opts.logger,
			onMount: (nerve) => {
				mountedNerve = nerve;
			},
			onUnmount: () => {
				mountedNerve = null;
			},
			description: "Child-Alef lifecycle management and task delegation: spawn, ask, kill, list, status, promote.",
			labels: ["orchestration", "spawn", "blue-green", "lifecycle"],
			directives: [
				`**orchestration organ — process isolation and organ development loop**

orchestration.spawn starts a full child Alef process. Startup takes 15–30s.
Never call spawn in parallel — three concurrent spawns will exceed the API timeout.
For fast in-process delegation use agent.run instead (available when organ-delegate is loaded).

When to use orchestration:
- True process isolation (different blueprint, sandboxed environment)
- The organ development loop (write → stage → eval → promote)
- Long-running background agents that outlive a single turn

Organ development loop:
1. Write a new organ to disk as a .ts file using nodesh.eval (export createOrgan(opts))
2. orchestration.spawn({ organs: ["./path/to/organ.ts"] }) — one child at a time
3. Use eval.run (organ-eval) to validate behaviour against the returned endpoint
4. If eval passes: orchestration.promote({ organPath }) — adds it to production, triggers blue-green
5. If eval fails: rewrite the organ via nodesh.eval and repeat from step 2

Rules:
- Never spawn more than one child at a time.
- orchestration.kill() every child after use.
- Always evaluate before promoting. Never promote an untested organ.
- organPath passed to orchestration.promote must be absolute.`,
			],
		},
	);
}
