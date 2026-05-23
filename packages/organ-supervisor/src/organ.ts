/**
 * SupervisorOrgan — child-Alef lifecycle management.
 *
 * Tools:
 *   supervisor.spawn   — start a child Alef, return endpoint + sessionId
 *   supervisor.kill    — stop a named child
 *   supervisor.list    — enumerate running children
 *   supervisor.status  — health-check a named child
 *   supervisor.promote — add an organ to the production blueprint, trigger blue-green
 *
 * The organ owns the Map<name, ChildEntry> and kills all children on unmount.
 * promote() fires process.send({ type: "rebuild" }) when running under supervisor.ts
 * (ALEF_SUPERVISOR=1), triggering the blue-green IPC loop.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { CorpusHandlerCtx, Organ, OrganLogger } from "@dpopsuev/alef-spine";
import { defineOrgan, getString } from "@dpopsuev/alef-spine";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import type { ChildEntry } from "./types.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface SupervisorOrganOptions {
	/** Working directory for child Alef processes. Defaults to process.cwd(). */
	cwd?: string;
	/** Timeout in ms waiting for a child to become ready. Default: 30_000. */
	readinessTimeoutMs?: number;
	logger?: OrganLogger;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
				child.stderr?.off("data", scan);
				resolveP({ endpoint, sessionId });
			}
		};

		child.stdout?.on("data", scan);
		child.stderr?.on("data", scan);
		child.once("exit", (code) => {
			clearTimeout(timer);
			rejectP(new Error(`Child exited (${code}) before ready`));
		});
	});
}

function healthCheck(endpoint: string): Promise<boolean> {
	return new Promise((res) => {
		http.get(`${endpoint}/health`, (resp) => res(resp.statusCode === 200)).on("error", () => res(false));
	});
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSupervisorOrgan(opts: SupervisorOrganOptions = {}): Organ {
	const cwd = opts.cwd ?? process.cwd();
	const readinessTimeoutMs = opts.readinessTimeoutMs ?? 30_000;
	const children = new Map<string, ChildEntry>();

	// -------------------------------------------------------------------------
	// spawn
	// -------------------------------------------------------------------------

	const SPAWN_TOOL = {
		name: "supervisor.spawn",
		description:
			"Start a child Alef process. Pass blueprintPath to an existing agent.yaml, or pass organs[] " +
			"with paths to TypeScript organ files (loaded via jiti, no build step). " +
			"Returns { name, endpoint, sessionId, pid } for subsequent supervisor.* calls.",
		inputSchema: z.object({
			blueprintPath: z
				.string()
				.optional()
				.describe("Path to an agent.yaml blueprint. Mutually exclusive with organs[]."),
			organs: z
				.array(z.string())
				.optional()
				.describe("Paths to .ts organ files. Supervisor writes a temp agent.yaml."),
			cwd: z.string().optional().describe("Working directory for the child. Defaults to parent cwd."),
			sessionId: z.string().optional().describe("Resume a previous session by ID."),
		}),
	};

	async function handleSpawn(ctx: CorpusHandlerCtx): Promise<Record<string, unknown>> {
		const childCwd = getString(ctx.payload, "cwd") ?? cwd;
		const blueprintPathRaw = getString(ctx.payload, "blueprintPath");
		const resumeSession = getString(ctx.payload, "sessionId");
		const organsRaw = ctx.payload.organs;
		const organPaths: string[] = Array.isArray(organsRaw) ? (organsRaw as string[]) : [];

		let blueprintPath = blueprintPathRaw ? resolvePath(blueprintPathRaw, childCwd) : undefined;
		let tmpDir: string | undefined;

		// Write a temp blueprint if inline organ paths were given.
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

		const env: NodeJS.ProcessEnv = {
			...process.env,
			ALEF_SUPERVISOR: "1",
		};

		const child = spawn(process.execPath, args, {
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

		const name = `child-${child.pid ?? Math.random().toString(36).slice(2)}`;
		const entry: ChildEntry = {
			name,
			endpoint: ready.endpoint,
			sessionId: ready.sessionId,
			pid: child.pid ?? 0,
			process: child,
			startedAt: Date.now(),
		};
		children.set(name, entry);

		// Cleanup tmpDir when child exits.
		child.once("exit", () => {
			children.delete(name);
			if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
		});

		return { name, endpoint: ready.endpoint, sessionId: ready.sessionId ?? "", pid: entry.pid };
	}

	// -------------------------------------------------------------------------
	// kill
	// -------------------------------------------------------------------------

	const KILL_TOOL = {
		name: "supervisor.kill",
		description: "Stop a named child Alef process (SIGTERM, then SIGKILL after 3s).",
		inputSchema: z.object({
			name: z.string().describe("Child name from supervisor.spawn"),
		}),
	};

	async function handleKill(ctx: CorpusHandlerCtx): Promise<Record<string, unknown>> {
		const name = getString(ctx.payload, "name") ?? "";
		const entry = children.get(name);
		if (!entry) return { stopped: false, reason: `no child named '${name}'` };

		entry.process.kill("SIGTERM");
		await new Promise<void>((res) => {
			const t = setTimeout(() => {
				entry.process.kill("SIGKILL");
				res();
			}, 3_000);
			entry.process.once("exit", () => {
				clearTimeout(t);
				res();
			});
		});
		children.delete(name);
		return { stopped: true, name };
	}

	// -------------------------------------------------------------------------
	// list
	// -------------------------------------------------------------------------

	const LIST_TOOL = {
		name: "supervisor.list",
		description: "List all running child Alef processes with their endpoints and session IDs.",
		inputSchema: z.object({}),
	};

	async function handleList(_ctx: CorpusHandlerCtx): Promise<Record<string, unknown>> {
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
		return { children: items };
	}

	// -------------------------------------------------------------------------
	// status
	// -------------------------------------------------------------------------

	const STATUS_TOOL = {
		name: "supervisor.status",
		description: "Health-check a named child Alef process.",
		inputSchema: z.object({
			name: z.string().describe("Child name from supervisor.spawn"),
		}),
	};

	async function handleStatus(ctx: CorpusHandlerCtx): Promise<Record<string, unknown>> {
		const name = getString(ctx.payload, "name") ?? "";
		const entry = children.get(name);
		if (!entry) return { alive: false, reason: `no child named '${name}'` };
		const alive = await healthCheck(entry.endpoint);
		return {
			name,
			alive,
			endpoint: entry.endpoint,
			sessionId: entry.sessionId ?? null,
			uptimeMs: Date.now() - entry.startedAt,
		};
	}

	// -------------------------------------------------------------------------
	// promote
	// -------------------------------------------------------------------------

	const PROMOTE_TOOL = {
		name: "supervisor.promote",
		description:
			"Add a new organ to the production blueprint and trigger a blue-green swap via the supervisor. " +
			"Only fires when running under supervisor.ts (ALEF_SUPERVISOR=1). " +
			"Returns { promoted: true } when the IPC rebuild was sent, { promoted: false } otherwise.",
		inputSchema: z.object({
			organPath: z.string().describe("Absolute path to the .ts organ file to add to production."),
			blueprintPath: z
				.string()
				.optional()
				.describe(
					"Path to the production blueprint to update. " +
						"Defaults to ALEF_BLUEPRINT_PATH env, then ~/.config/alef/agent.yaml.",
				),
		}),
	};

	function handlePromote(ctx: CorpusHandlerCtx): Record<string, unknown> {
		const organPathRaw = getString(ctx.payload, "organPath") ?? "";
		const organPath = resolvePath(organPathRaw, cwd);

		const bpRaw = getString(ctx.payload, "blueprintPath");
		const blueprintPath = bpRaw
			? resolvePath(bpRaw, cwd)
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

	// -------------------------------------------------------------------------
	// Organ definition
	// -------------------------------------------------------------------------

	return defineOrgan(
		"supervisor",
		{
			"motor/supervisor.spawn": { tool: SPAWN_TOOL, handle: handleSpawn },
			"motor/supervisor.kill": { tool: KILL_TOOL, handle: handleKill },
			"motor/supervisor.list": { tool: LIST_TOOL, handle: handleList },
			"motor/supervisor.status": { tool: STATUS_TOOL, handle: handleStatus },
			"motor/supervisor.promote": {
				tool: PROMOTE_TOOL,
				handle: (ctx: CorpusHandlerCtx) => Promise.resolve(handlePromote(ctx)),
			},
		},
		{
			logger: opts.logger,
			description: "Child-Alef lifecycle management: spawn, kill, list, status, promote.",
			labels: ["supervisor", "spawn", "blue-green", "lifecycle"],
			directives: [
				`**supervisor organ — agentic organ development loop**
Use this organ to develop, test, and promote new organs without human intervention.

Loop:
1. Write a new organ to disk as a .ts file using nodesh.eval (export createOrgan(opts))
2. supervisor.spawn({ organs: ["./path/to/organ.ts"] }) — starts a staging Alef with the organ loaded
3. Use eval.run (organ-eval) to send test prompts to the returned endpoint and validate behaviour
4. If eval passes: supervisor.promote({ organPath }) — adds it to production and triggers blue-green swap
5. If eval fails: rewrite the organ via nodesh.eval and repeat from step 2

Rules:
- Always evaluate before promoting. Never promote an organ you have not tested.
- supervisor.kill() the staging child after evaluation (pass or fail) to free resources.
- organPath passed to supervisor.promote must be absolute.`,
			],
		},
	);
}
