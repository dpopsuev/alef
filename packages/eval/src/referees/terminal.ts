/**
 * TerminalReferee — runs a bash test script in the workspace.
 *
 * Equivalent to TerminalBench's `tests/test.sh` verifier convention.
 * The script writes `1` to stdout for pass or `0` for fail,
 * OR uses exit code 0 for pass / non-zero for fail.
 *
 * Score:
 *   1.0 — exit code 0 (and stdout is "1" if present)
 *   0.0 — non-zero exit code or stdout is "0"
 *
 * The test script runs in the workspace directory with bash.
 * All tools installed in the environment (openssl, python3, jq, etc.) are available.
 *
 * Ref: ALE-TSK-161
 */

import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Referee, RefereeContext, RefereeResult } from "../evaluation.js";

function runScript(
	script: string,
	workspace: string,
	timeoutMs: number,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	// Write script to a temp file in workspace
	const scriptPath = join(workspace, ".tb-test.sh");
	writeFileSync(scriptPath, `#!/bin/bash\nset -e\ncd "${workspace}"\n${script}\n`, { mode: 0o755 });

	return new Promise((resolve) => {
		const proc = spawn("bash", [scriptPath], {
			cwd: workspace,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (d: Buffer) => {
			stdout += d.toString();
		});
		proc.stderr.on("data", (d: Buffer) => {
			stderr += d.toString();
		});

		const timer = setTimeout(() => {
			proc.kill("SIGTERM");
			resolve({ exitCode: 124, stdout, stderr: `${stderr}\nTimeout after ${timeoutMs}ms` });
		}, timeoutMs);

		proc.on("close", (code) => {
			clearTimeout(timer);
			resolve({ exitCode: code ?? 1, stdout, stderr });
		});
	});
}

/**
 * Create a TerminalReferee from an inline bash script.
 *
 * @param script  Bash script content. Can use any host tools.
 * @param timeoutMs  Script timeout. Default: 30s.
 *
 * @example
 * terminalScript(`
 *   python3 hello.py > /tmp/out.txt
 *   grep -q "Hello, World!" /tmp/out.txt
 * `)
 */
export function terminalScript(script: string, timeoutMs = 30_000): Referee {
	return {
		async check({ workspace }: RefereeContext): Promise<RefereeResult> {
			const { exitCode, stdout, stderr } = await runScript(script, workspace, timeoutMs);

			// TerminalBench convention: stdout "1" = pass, "0" = fail.
			// Also accept pure exit-code convention (exit 0 = pass).
			const stdoutTrimmed = stdout.trim();
			if (stdoutTrimmed === "0") {
				return { pass: false, score: 0, errors: [`Test script reported failure (stdout=0)\n${stderr}`] };
			}
			if (exitCode === 0) {
				return { pass: true, score: 1.0, errors: [] };
			}
			return {
				pass: false,
				score: 0,
				errors: [`Test script failed (exit ${exitCode})`, ...(stderr.trim() ? [stderr.trim().slice(0, 500)] : [])],
			};
		},
	};
}

/**
 * Create a TerminalReferee from a script file path.
 * The file must be accessible at the time check() runs.
 */
export function terminalScriptFile(scriptPath: string, timeoutMs = 30_000): Referee {
	return {
		async check(ctx: RefereeContext): Promise<RefereeResult> {
			if (!existsSync(scriptPath)) {
				return { pass: false, score: 0, errors: [`Test script not found: ${scriptPath}`] };
			}
			const { readFileSync } = await import("node:fs");
			const script = readFileSync(scriptPath, "utf-8");
			return terminalScript(script, timeoutMs).check(ctx);
		},
	};
}
