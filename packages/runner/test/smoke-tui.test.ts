/**
 * TUI process-exit smoke tests using node-pty.
 *
 * node-pty creates a real pseudo-terminal. The runner process believes it
 * has a TTY, activates TUI mode, and responds to actual keystrokes.
 *
 * These tests prove the wiring the unit tests cannot:
 *   - Typing /exit actually terminates the process
 *   - Ctrl+C when idle actually terminates the process
 *   - Neither hangs (process exits within timeout)
 *
 * Uses ALEF_SCRIPTED_REPLIES so no real LLM is needed.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as pathResolve } from "node:path";
import { spawn as ptySpawn } from "node-pty";
import { afterEach, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const ROOT = pathResolve(__dirname, "../../..");
const TSX = pathResolve(ROOT, "node_modules/tsx/dist/cli.mjs");
const RUNNER_MAIN = pathResolve(__dirname, "../src/main.ts");
const TSCONFIG = pathResolve(ROOT, "tsconfig.json");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tmps: string[] = [];

afterEach(() => {
	for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeTmp(): string {
	const d = mkdtempSync(join(tmpdir(), "alef-tui-smoke-"));
	tmps.push(d);
	return d;
}

interface PtyResult {
	exitCode: number | null;
	output: string;
}

/**
 * Spawn the runner in a PTY and run a scenario function.
 * The scenario receives the pty instance and a helper to wait for output.
 * Returns exit code and full output when the process exits.
 */
function runInPty(
	cwd: string,
	replies: string[],
	scenario: (
		write: (data: string) => void,
		waitFor: (pattern: RegExp, timeoutMs?: number) => Promise<void>,
		output: () => string,
	) => Promise<void>,
	timeoutMs = 20_000,
): Promise<PtyResult> {
	return new Promise((resolve, reject) => {
		let out = "";
		const timer = setTimeout(() => {
			pty.kill();
			reject(new Error(`PTY timed out after ${timeoutMs}ms.\nOutput:\n${out}`));
		}, timeoutMs);

		const pty = ptySpawn(process.execPath, [TSX, RUNNER_MAIN], {
			name: "xterm-256color",
			cols: 80,
			rows: 24,
			cwd,
			env: {
				...process.env,
				ALEF_SCRIPTED_REPLIES: JSON.stringify(replies),
				TSX_TSCONFIG_PATH: TSCONFIG,
				// Suppress colour/box-drawing for easier pattern matching
				NO_COLOR: "1",
			},
		});

		pty.onData((data) => {
			out += data;
		});

		pty.onExit(({ exitCode }) => {
			clearTimeout(timer);
			resolve({ exitCode, output: out });
		});

		const waitFor = (pattern: RegExp, ms = 10_000): Promise<void> =>
			new Promise((res, rej) => {
				if (pattern.test(out)) {
					res();
					return;
				}
				const poll = setInterval(() => {
					if (pattern.test(out)) {
						clearInterval(poll);
						clearTimeout(t);
						res();
					}
				}, 100);
				const t = setTimeout(() => {
					clearInterval(poll);
					rej(new Error(`waitFor(${pattern}) timed out.\nOutput:\n${out.slice(-500)}`));
				}, ms);
			});

		scenario(pty.write.bind(pty), waitFor, () => out).catch((err: unknown) => {
			clearTimeout(timer);
			pty.kill();
			reject(err);
		});
	});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TUI process-exit smoke (node-pty)", () => {
	it("/exit terminates the process with exit code 0", async () => {
		const cwd = makeTmp();
		const result = await runInPty(cwd, ["scripted reply"], async (write, waitFor) => {
			// Wait for the TUI header to appear.
			await waitFor(/ALEF|session:/);
			// Small settle — TUI needs to be ready for input.
			await new Promise((r) => setTimeout(r, 300));
			write("/exit\r");
		});

		expect(result.exitCode).toBe(0);
	}, 25_000);

	it("Ctrl+C when idle terminates the process with exit code 0", async () => {
		const cwd = makeTmp();
		const result = await runInPty(cwd, ["scripted reply"], async (write, waitFor) => {
			await waitFor(/ALEF|session:/);
			await new Promise((r) => setTimeout(r, 300));
			write("\x03"); // Ctrl+C
		});

		expect(result.exitCode).toBe(0);
	}, 25_000);

	it("Ctrl+C mid-turn cancels the turn without exiting, second Ctrl+C exits", async () => {
		const cwd = makeTmp();
		const result = await runInPty(cwd, ["scripted reply"], async (write, waitFor) => {
			await waitFor(/ALEF|session:/);
			await new Promise((r) => setTimeout(r, 300));

			// Send a message to start a turn.
			write("hello\r");
			// Mid-turn Ctrl+C — should interrupt, not exit.
			await new Promise((r) => setTimeout(r, 200));
			write("\x03");
			// Wait for the interrupted notice or input to reappear.
			await waitFor(/interrupted|\/exit/, 5_000);
			// Second Ctrl+C — now idle, should exit.
			await new Promise((r) => setTimeout(r, 300));
			write("\x03");
		});

		expect(result.exitCode).toBe(0);
	}, 30_000);
});
