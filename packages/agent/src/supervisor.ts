/**
 * Blue-green supervisor for Alef runner.
 *
 * Manages a single "current" slot (the green instance). When the runner
 * requests a rebuild via IPC ({ type: "rebuild" }), the supervisor:
 *
 *   1. Runs the build command (compile, test, etc.)
 *   2. Spawns a new green with the current session ID (for continuity)
 *   3. Waits for the new green to signal readiness ("router listening on")
 *   4. Sends handoff_prepare to the old green, waits for handoff_ack
 *   5. Kills the old green — new green is now the active slot
 *   6. Emits "Promoted staging slot" to stderr
 *
 * Session continuity: the runner emits "[session] <id>" to stderr on start.
 * The supervisor captures this and passes ALEF_CURRENT_SESSION=<id> to the
 * next green so it can --resume from the same JSONL file.
 *
 * Configuration via env vars (all optional):
 *   ALEF_SUPERVISOR_GREEN_SCRIPT         Path to the green entry script
 *   ALEF_SUPERVISOR_BUILD_COMMAND        Shell command to run before promoting
 *   ALEF_SUPERVISOR_HANDOFF_PATH         Write handoff envelope JSON here
 *   ALEF_SUPERVISOR_SKIP_HEALTH          "1" to skip readiness wait (tests)
 *   ALEF_SUPERVISOR_TEST_EVAL_RESULT     "pass"/"fail" — mock eval gate (tests)
 *   ALEF_SUPERVISOR_AUTO_REBUILD_ON_START "0" to skip initial rebuild
 */

import { type ChildProcess, exec as execCb, type Serializable, spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execCb);

const selfPath = new URL(import.meta.url).pathname;
const selfExt = selfPath.endsWith(".ts") ? ".ts" : ".js";
const DEFAULT_GREEN_SCRIPT = join(dirname(selfPath), `cli/main${selfExt}`);
const GREEN_SCRIPT = process.env.ALEF_SUPERVISOR_GREEN_SCRIPT || DEFAULT_GREEN_SCRIPT;
const BUILD_COMMAND = process.env.ALEF_SUPERVISOR_BUILD_COMMAND ?? "";
const HANDOFF_PATH = process.env.ALEF_SUPERVISOR_HANDOFF_PATH ?? "";
const SKIP_HEALTH = process.env.ALEF_SUPERVISOR_SKIP_HEALTH === "1";
const TEST_EVAL_RESULT = process.env.ALEF_SUPERVISOR_TEST_EVAL_RESULT ?? "";
const GREEN_ARGS: string[] = process.env.ALEF_SUPERVISOR_GREEN_ARGS
	? (JSON.parse(process.env.ALEF_SUPERVISOR_GREEN_ARGS) as string[])
	: process.argv.slice(2);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let current: ChildProcess | undefined;
let currentSessionId: string | undefined;
let rebuilding = false;

/** Resolves when the current green has emitted "router listening on". */
let readyResolve: (() => void) | undefined;
/** Rejects readyPromise when the new green exits before becoming ready. */
let readyReject: ((err: Error) => void) | undefined;
let readyPromise: Promise<void> = Promise.resolve();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Walk up from scriptPath to find the nearest node_modules/.bin/tsx binary. */
function findTsxBin(scriptPath: string): string {
	let dir = dirname(scriptPath);
	while (true) {
		const candidate = join(dir, "node_modules/tsx/dist/cli.mjs");
		if (existsSync(candidate)) return candidate;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return "tsx";
}

// ---------------------------------------------------------------------------
// Green lifecycle
// ---------------------------------------------------------------------------

function spawnGreen(sessionId?: string): ChildProcess {
	const env: NodeJS.ProcessEnv = { ...process.env, ALEF_SUPERVISOR: "1" };
	if (sessionId) env.ALEF_CURRENT_SESSION = sessionId;

	// New readiness gate for this slot.
	readyResolve = undefined;
	readyReject = undefined;
	if (!SKIP_HEALTH) {
		readyPromise = new Promise<void>((resolve, reject) => {
			readyResolve = () => {
				resolve();
				readyResolve = undefined;
				readyReject = undefined;
			};
			readyReject = (err: Error) => {
				reject(err);
				readyResolve = undefined;
				readyReject = undefined;
			};
		});
	} else {
		readyPromise = Promise.resolve();
	}

	// Use tsx when spawning a TypeScript green script so source runs without a build step.
	// Walk up from the green script to find the nearest node_modules/.bin/tsx.
	// ALEF_SUPERVISOR_TSX_BIN overrides the resolved path (useful in tests).
	const isTsScript = GREEN_SCRIPT.endsWith(".ts") || GREEN_SCRIPT.endsWith(".tsx");
	const spawnArgs = isTsScript
		? [process.env.ALEF_SUPERVISOR_TSX_BIN ?? findTsxBin(GREEN_SCRIPT), GREEN_SCRIPT]
		: [GREEN_SCRIPT];
	const child = spawn(process.execPath, [...spawnArgs, ...GREEN_ARGS], {
		env,
		stdio: ["inherit", "inherit", "inherit", "ipc"],
	});

	// Forward IPC from green to supervisor's parent (if nested).
	child.on("message", (msg: unknown) => {
		handleGreenMessage(msg);
	});

	child.on("exit", (code, signal) => {
		if (rebuilding) {
			readyReject?.(new Error(`Green exited (${code}/${signal}) before ready`));
			return;
		}
		if (code === 0 || signal === "SIGTERM" || signal === "SIGINT") {
			process.exit(code ?? 0);
		}
		process.stderr.write(`[supervisor] green crashed (code=${code} signal=${signal}), restarting…\n`);
		current = spawnGreen(currentSessionId);
	});

	return child;
}

// ---------------------------------------------------------------------------
// Rebuild / blue-green swap
// ---------------------------------------------------------------------------

async function doRebuild(): Promise<void> {
	if (rebuilding) {
		process.stderr.write("[supervisor] rebuild already in progress, skipping\n");
		return;
	}
	rebuilding = true;
	const old = current;
	const sessionId = currentSessionId;

	try {
		// 1. Build step.
		if (BUILD_COMMAND) {
			process.stderr.write(`[supervisor] build: ${BUILD_COMMAND}\n`);
			await exec(BUILD_COMMAND);
		}

		// 2. Eval gate (test hook — production would run smoke tests here).
		if (TEST_EVAL_RESULT === "fail") {
			process.stderr.write("[supervisor] eval gate: FAIL — aborting promotion\n");
			return;
		}

		// 3. Spawn new green with session continuity.
		process.stderr.write(`[supervisor] starting staging slot (session=${sessionId ?? "none"})\n`);
		current = spawnGreen(sessionId);

		// 4. Wait for new green to be ready.
		await readyPromise;

		// 5. Graceful handoff of old green.
		if (old && !old.killed) {
			const updateId = crypto.randomUUID();
			const envelope = {
				schemaVersion: "v1",
				updateId,
				sourceSlot: "old",
				targetSlot: "new",
				sessionFile: sessionId ?? "",
				phase: "prepared",
				preparedAt: Date.now(),
			};

			old.send({ type: "handoff_prepare", envelope });

			// Wait for ack with timeout (don't block promotion if old green is unresponsive).
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, 5_000);
				const onMsg = (msg: unknown) => {
					const m = msg as { type?: string; updateId?: string };
					if (m.type === "handoff_ack" && m.updateId === updateId) {
						clearTimeout(timer);
						old.off("message", onMsg);
						resolve();
					}
				};
				old.on("message", onMsg);
			});

			if (HANDOFF_PATH) {
				writeFileSync(HANDOFF_PATH, JSON.stringify({ ...envelope, completedAt: Date.now() }, null, 2));
			}

			old.kill("SIGTERM");
		}

		process.stderr.write("[supervisor] Promoted staging slot.\n");
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		process.stderr.write(`[supervisor] rebuild failed: ${msg}\n`);
		// Roll back: restore old green if new one failed to start.
		if (old && !old.killed) {
			current = old;
		}
	} finally {
		rebuilding = false;
	}
}

// ---------------------------------------------------------------------------
// Scoped update — runs before doRebuild() based on upgradePolicy scope
// ---------------------------------------------------------------------------

let updating = false;

async function doUpdate(scope: string): Promise<void> {
	if (updating) {
		process.stderr.write("[supervisor] update already in progress, ignoring duplicate request\n");
		return;
	}
	updating = true;
	try {
		const { upgrade, init } = await import("./alef-pm.js");
		if (scope === "packages") {
			process.stderr.write("[supervisor] upgrading adapters (scope=packages)\n");
			init();
			await upgrade();
		} else if (scope === "self") {
			process.stderr.write("[supervisor] self-upgrade (scope=self)\n");
			// Resolve the global npm prefix to find where the new binary will land.
			const { execSync, execFileSync } = await import("node:child_process");
			let globalBin: string;
			try {
				globalBin = `${execSync("npm prefix -g", { encoding: "utf-8" }).trim()}/bin/alef`;
			} catch {
				globalBin = "";
			}
			// npm_execpath is set by npm when running a lifecycle script; fall back to
			// the bare 'npm' shell command (not node + npm_execpath) for direct invocations.
			const npmCmd = process.env.npm_execpath ? `${process.execPath} "${process.env.npm_execpath}"` : "npm";
			try {
				await exec(`${npmCmd} install -g alef-runner@latest`);
			} catch (err) {
				process.stderr.write(
					`[supervisor] npm install -g failed — staying on current version: ${err instanceof Error ? err.message : String(err)}\n`,
				);
				return;
			}
			// Re-exec the newly installed global binary, not the old supervisor script.
			if (globalBin) {
				process.stderr.write(`[supervisor] re-exec new binary at ${globalBin}\n`);
				execFileSync(globalBin, process.argv.slice(2), { stdio: "inherit" });
				process.exit(0);
			} else {
				process.stderr.write("[supervisor] could not resolve global bin path — restart manually\n");
				return;
			}
		}
	} catch (err) {
		process.stderr.write(
			`[supervisor] update (scope=${scope}) failed: ${err instanceof Error ? err.message : String(err)}\n`,
		);
	} finally {
		updating = false;
	}
	await doRebuild();
}

// ---------------------------------------------------------------------------
// IPC dispatch
// ---------------------------------------------------------------------------

function handleGreenMessage(msg: unknown): void {
	const m = msg as { type?: string; scope?: string; sessionId?: string };

	if (m.type === "ready") {
		readyResolve?.();
		readyResolve = undefined;
		return;
	}

	if (m.type === "session") {
		if (m.sessionId) currentSessionId = m.sessionId;
		return;
	}

	if (m.type === "rebuild") {
		void doRebuild();
		return;
	}

	if (m.type === "update") {
		void doUpdate(m.scope ?? "rebuild");
		return;
	}

	if (typeof process.send === "function") {
		process.send(msg);
	}
}

// Handle messages from supervisor's own parent (e.g. outer orchestrator).
process.on("message", (msg: unknown) => {
	// Forward to current green (which bridges to the runner).
	if (current?.connected) {
		current.send(msg as Serializable);
	}
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

process.stderr.write("[supervisor] starting green\n");
current = spawnGreen();

process.on("SIGTERM", () => {
	process.stderr.write("[supervisor] SIGTERM received, stopping green\n");
	current?.kill("SIGTERM");
	process.exit(0);
});

process.on("SIGINT", () => {
	current?.kill("SIGTERM");
	process.exit(0);
});
