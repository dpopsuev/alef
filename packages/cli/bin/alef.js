#!/usr/bin/env node
/**
 * Alef CLI wrapper -- owns the terminal for the process lifetime.
 *
 * Spawns the real entrypoint as a child with stdio:inherit.
 * If the child exits with code 75 (EX_TEMPFAIL), the wrapper respawns
 * a fresh child -- this is the :restart / :reboot protocol.
 * Any other exit code is propagated to the parent shell.
 *
 * Signal forwarding: SIGINT, SIGTERM, SIGWINCH, SIGHUP are forwarded
 * to the child. The wrapper itself ignores these so it stays alive
 * as the terminal owner.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";

const RESTART_EXIT_CODE = 75;
const __dirname = dirname(fileURLToPath(import.meta.url));

const entryTs = resolve(__dirname, "../src/entrypoint.ts");
const entryJs = resolve(__dirname, "../dist/entrypoint.js");

function buildChildArgs() {
	const useTs = !existsSync(entryJs);
	if (useTs) {
		const tsx = resolve(__dirname, "../node_modules/tsx/dist/cli.mjs");
		return { execPath: process.execPath, args: [tsx, entryTs, ...process.argv.slice(2)] };
	}
	return { execPath: process.execPath, args: [entryJs, ...process.argv.slice(2)] };
}

function spawnChild() {
	const { execPath, args } = buildChildArgs();
	const child = spawn(execPath, args, {
		env: { ...process.env, ALEF_WRAPPER: "1" },
		stdio: "inherit",
	});

	// Forward signals to child
	const forward = (sig) => {
		try { child.kill(sig); } catch { /* child may have already exited */ }
	};

	const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
	for (const sig of signals) {
		process.on(sig, () => forward(sig));
	}

	// SIGWINCH does not kill -- just forward for terminal resize
	if (process.platform !== "win32") {
		process.on("SIGWINCH", () => forward("SIGWINCH"));
	}

	child.on("exit", (code, signal) => {
		// Clean up signal handlers before deciding next action
		for (const sig of signals) {
			process.removeAllListeners(sig);
		}
		if (process.platform !== "win32") {
			process.removeAllListeners("SIGWINCH");
		}

		if (code === RESTART_EXIT_CODE) {
			// Restart requested -- spawn a fresh child
			spawnChild();
			return;
		}

		// Normal exit -- propagate to parent shell
		if (signal) {
			process.kill(process.pid, signal);
		} else {
			process.exit(code ?? 0);
		}
	});

	return child;
}

spawnChild();
