/**
 * E2E tests for main.ts — spawn the runner as a subprocess, check output.
 *
 * Deterministic tests (no LLM): --help, invalid args, empty prompt.
 * Real-LLM tests: skipped when no credentials are detected.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hasCredentials } from "../src/model.js";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const TSX = fileURLToPath(new URL("../../../node_modules/.bin/tsx", import.meta.url));

const SKIP_LLM = !hasCredentials();

interface RunResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

function run(args: string[], stdinInput?: string): Promise<RunResult> {
	return new Promise((resolve) => {
		const proc = spawn(TSX, [MAIN, ...args], {
			env: { ...process.env },
			stdio: ["pipe", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";

		proc.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		proc.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});

		if (stdinInput !== undefined) {
			proc.stdin.write(stdinInput);
			proc.stdin.end();
		} else {
			proc.stdin.end();
		}

		proc.on("close", (code) => {
			resolve({ stdout, stderr, exitCode: code ?? 1 });
		});
	});
}

// ---------------------------------------------------------------------------
// Deterministic — no LLM required
// ---------------------------------------------------------------------------

describe("runner E2E — deterministic", () => {
	it("--help prints usage and exits 0", async () => {
		const result = await run(["--help"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Usage: alef");
		expect(result.stdout).toContain("--print");
		expect(result.stdout).toContain("--cwd");
		expect(result.stdout).toContain("--json");
	});

	it("-h is an alias for --help", async () => {
		const result = await run(["-h"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Usage: alef");
	});

	it("unknown flag exits 1 with error message", async () => {
		const result = await run(["--not-a-flag"]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("Unknown option");
		expect(result.stderr).toContain("--not-a-flag");
	});

	it("print mode with empty prompt exits 1 with error message", async () => {
		const result = await run(["-p", ""]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("requires a prompt");
	});

	it("empty stdin in interactive mode exits 0 cleanly", async () => {
		const result = await run([], "");
		expect(result.exitCode).toBe(0);
	});

	it("/exit in interactive mode exits 0 cleanly", async () => {
		const result = await run([], "/exit\n");
		expect(result.exitCode).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Real-LLM — skipped without credentials
// ---------------------------------------------------------------------------

describe.skipIf(SKIP_LLM)("runner E2E — real LLM", () => {
	it("print mode: sends prompt, prints reply, exits 0", async () => {
		const result = await run(["-p", "Respond with exactly the word ALIVE and nothing else."]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout.toUpperCase()).toContain("ALIVE");
	}, 60_000);

	it("--json mode: output is valid JSONL with type=reply", async () => {
		const result = await run(["--json", "-p", "Say READY."]);
		expect(result.exitCode).toBe(0);

		const lines = result.stdout.trim().split("\n").filter(Boolean);
		expect(lines.length).toBeGreaterThan(0);

		const event = JSON.parse(lines[0]);
		expect(event.type).toBe("reply");
		expect(typeof event.text).toBe("string");
		expect(typeof event.ts).toBe("number");
	}, 60_000);

	it("--cwd sets working directory for FsOrgan", async () => {
		const result = await run([
			"--cwd",
			fileURLToPath(new URL("../src", import.meta.url)),
			"-p",
			"List the .ts files in the current directory. Just filenames, no explanation.",
		]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("main.ts");
	}, 60_000);
});
