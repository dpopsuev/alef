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
import { writeFileSync } from "node:fs";
import { promisify } from "node:util";

const exec = promisify(execCb);

const GREEN_SCRIPT = process.env.ALEF_SUPERVISOR_GREEN_SCRIPT ?? "";
const BUILD_COMMAND = process.env.ALEF_SUPERVISOR_BUILD_COMMAND ?? "";
const HANDOFF_PATH = process.env.ALEF_SUPERVISOR_HANDOFF_PATH ?? "";
const SKIP_HEALTH = process.env.ALEF_SUPERVISOR_SKIP_HEALTH === "1";
const TEST_EVAL_RESULT = process.env.ALEF_SUPERVISOR_TEST_EVAL_RESULT ?? "";

if (!GREEN_SCRIPT) {
	process.stderr.write("[supervisor] ALEF_SUPERVISOR_GREEN_SCRIPT is required\n");
	process.exit(1);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let current: ChildProcess | undefined;
let currentSessionId: string | undefined;
let rebuilding = false;

/** Resolves when the current green has emitted "router listening on". */
let readyResolve: (() => void) | undefined;
let readyPromise: Promise<void> = Promise.resolve();

// ---------------------------------------------------------------------------
// Green lifecycle
// ---------------------------------------------------------------------------

function spawnGreen(sessionId?: string): ChildProcess {
	const env: NodeJS.ProcessEnv = { ...process.env };
	if (sessionId) env.ALEF_CURRENT_SESSION = sessionId;

	// New readiness gate for this slot.
	readyResolve = undefined;
	if (!SKIP_HEALTH) {
		readyPromise = new Promise<void>((resolve) => {
			readyResolve = resolve;
		});
	} else {
		readyPromise = Promise.resolve();
	}

	const child = spawn(process.execPath, [GREEN_SCRIPT], {
		env,
		stdio: ["inherit", "pipe", "pipe", "ipc"],
	});

	// Tee stdout: pass through + check for readiness signal.
	child.stdout?.on("data", (chunk: Buffer) => {
		process.stdout.write(chunk);
		if (chunk.toString().includes("router listening on")) {
			readyResolve?.();
			readyResolve = undefined;
		}
	});

	// Tee stderr: pass through + parse session ID + check readiness.
	child.stderr?.on("data", (chunk: Buffer) => {
		process.stderr.write(chunk);
		const text = chunk.toString();
		// Capture session ID for handoff continuity.
		// Lines are either "[session] <id>" (new) or "[session] Resumed <id> (N turns)" (resume).
		const sessionMatch = text.match(/\[session\]\s+(?:Resumed\s+)?(\S+)/);
		// Guard: ignore the word count suffix, parentheses, etc.
		const rawId = sessionMatch?.[1];
		const sessionId = rawId && !/^\(|turns/.test(rawId) ? rawId : undefined;
		if (sessionId) currentSessionId = sessionId;
		if (text.includes("router listening on")) {
			readyResolve?.();
			readyResolve = undefined;
		}
	});

	// Forward IPC from green to supervisor's parent (if nested).
	child.on("message", (msg: unknown) => {
		handleGreenMessage(msg);
	});

	child.on("exit", (code, signal) => {
		if (!rebuilding) {
			process.stderr.write(`[supervisor] green exited (code=${code} signal=${signal}), restarting…\n`);
			current = spawnGreen(currentSessionId);
		}
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
// IPC dispatch
// ---------------------------------------------------------------------------

function handleGreenMessage(msg: unknown): void {
	const m = msg as { type?: string };

	if (m.type === "rebuild" || m.type === "update") {
		void doRebuild();
		return;
	}

	// Forward anything else up to supervisor's parent (if the supervisor
	// itself is supervised — nested blue-green).
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
