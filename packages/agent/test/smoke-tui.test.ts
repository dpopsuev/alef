/**
 * TUI smoke tests — process lifecycle via a real PTY.
 * Uses ALEF_SCRIPTED_REPLIES so no real LLM is needed.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as pathResolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

let ptySpawn: typeof import("node-pty").spawn | undefined;
try {
	ptySpawn = (await import("node-pty")).spawn;
} catch {
	// native module not built — tests will be skipped
}

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

afterEach(async () => {
	for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
	// Drain the terminal buffer between PTY tests — prevents Ctrl+C from test 3
	// leaking into test 4's PTY allocation through the shared terminal state.
	await new Promise((r) => setTimeout(r, 150));
});

function makeTmp(): string {
	const d = mkdtempSync(join(tmpdir(), "alef-test-"));
	tmps.push(d);
	return d;
}

interface PtyResult {
	exitCode: number;
	output: string;
}

type SmokeStep = string | { kind: "toolCall"; call: { name: string; args: Record<string, unknown> }; reply: string };

function runInPty(
	cwd: string,
	replies: SmokeStep[],
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

		const pty = ptySpawn!(process.execPath, [TSX, RUNNER_MAIN], {
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
				// ALEF_DEBUG emits [ALEF_READY] when the TUI input loop is live.
				ALEF_DEBUG: "1",
			},
		});

		pty.onData((data) => {
			out += data;
		});

		pty.onExit(({ exitCode }) => {
			clearTimeout(timer);
			resolve({ exitCode, output: out });
		});

		const waitFor = (pattern: RegExp, ms = 15_000): Promise<void> =>
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

const suite = ptySpawn ? describe : describe.skip;
suite("TUI process-exit smoke (node-pty)", { tags: ["integration"] }, () => {
	it("/exit terminates the process with exit code 0", async () => {
		const cwd = makeTmp();
		const result = await runInPty(cwd, ["scripted reply"], async (write, waitFor) => {
			await waitFor(/\[ALEF_READY\]/);
			write("/exit\r");
		});

		expect(result.exitCode).toBe(0);
	}, 25_000);

	it("Ctrl+C when idle terminates the process with exit code 0", async () => {
		const cwd = makeTmp();
		const result = await runInPty(cwd, ["scripted reply"], async (write, waitFor) => {
			await waitFor(/\[ALEF_READY\]/);
			write("\x03"); // Ctrl+C
		});

		expect(result.exitCode).toBe(0);
	}, 25_000);

	it("Ctrl+C mid-turn cancels the turn without exiting, second Ctrl+C exits", async () => {
		const cwd = makeTmp();
		const result = await runInPty(cwd, ["scripted reply"], async (write, waitFor) => {
			await waitFor(/\[ALEF_READY\]/);
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

	// ScriptedReasoner now fires onToolStart/onToolEnd/onResponseChunk.
	// Tool pill block renders AND reply text appears via onResponseChunk (not sink).
	it("tool-call step: tool block and reply text appear, TUI does not hang", async () => {
		const cwd = makeTmp();
		const steps: SmokeStep[] = [
			{
				kind: "toolCall",
				call: { name: "fs.find", args: { path: cwd, pattern: "*" } },
				reply: "Explored and found nothing unusual.",
			},
		];
		const result = await runInPty(
			cwd,
			steps,
			async (write, waitFor) => {
				await waitFor(/\[ALEF_READY\]/);

				write("explore\r");

				// Tool pill block must appear (onToolStart/onToolEnd wired).
				await waitFor(/fs\.find/, 20_000);

				// Reply text must appear via onResponseChunk.
				await waitFor(/found nothing unusual/, 15_000);

				write("/exit\r");
			},
			40_000,
		);

		if (result.exitCode !== 0) {
			process.stderr.write(`\n[smoke-tui] tool-call PTY output:\n${result.output}\n`);
		}
		expect(result.exitCode).toBe(0);
	}, 45_000);
});
