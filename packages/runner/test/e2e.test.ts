/**
 * E2E tests for main.ts — spawn the runner as a subprocess, check output.
 *
 * Deterministic only. Real-LLM CLI mode tests live in alef-coding-agent/test/cli-modes.test.ts.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const TSX = fileURLToPath(new URL("../../../node_modules/.bin/tsx", import.meta.url));
const TSCONFIG = fileURLToPath(new URL("../../../tsconfig.json", import.meta.url));

interface RunResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

function run(args: string[], stdinInput?: string): Promise<RunResult> {
	return new Promise((resolve) => {
		const proc = spawn(TSX, [MAIN, ...args], {
			env: { ...process.env, TSX_TSCONFIG_PATH: TSCONFIG },
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

describe("runner E2E — deterministic", { tags: ["e2e"] }, () => {
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
