/**
 * TestReferee — runs vitest in the workspace and checks all tests pass.
 *
 * Symlinks the monorepo's node_modules into the workspace so vitest and
 * any test imports resolve without a separate install.
 *
 * Score:
 *   1.0 — all tests pass
 *   0.5 — some tests pass (partial)
 *   0.0 — all tests fail or runner error
 */

import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { symlink } from "node:fs/promises";
import { join } from "node:path";
import type { Checker, CheckerContext, CheckerResult } from "../evaluation.js";
import { buildEvalTsconfig, buildEvalVitestConfig, monorepoNodeModulesPath, monorepoPath } from "./tooling-paths.js";

const MONOREPO_NODE_MODULES = monorepoNodeModulesPath();
const VITEST_CLI = monorepoPath("node_modules", "vitest", "vitest.mjs");
const CHILD_VITEST_TIMEOUT_MS = 15_000;
const CHILD_VITEST_KILL_GRACE_MS = 250;
const PROCESS_TIMEOUT_EXIT_CODE = 124;

/**
 *
 */
function childVitestEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const key of Object.keys(env)) {
		if (key.startsWith("VITEST")) delete env[key];
	}
	return env;
}

/**
 *
 */
function runVitest(workspace: string): Promise<{ exitCode: number; output: string }> {
	return new Promise((resolve) => {
		const vitestConfig = join(workspace, "vitest.config.ts");
		const proc = spawn(
			process.execPath,
			[VITEST_CLI, "run", "--root", workspace, "--config", vitestConfig, "--reporter", "verbose"],
			{
				cwd: workspace,
				stdio: ["ignore", "pipe", "pipe"],
				env: childVitestEnv(),
			},
		);
		let output = "";
		let timedOut = false;
		let settled = false;
		const settle = (exitCode: number): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			resolve({
				exitCode,
				output: timedOut ? `${output}\nVitest timed out after ${CHILD_VITEST_TIMEOUT_MS}ms` : output,
			});
		};
		const timeout = setTimeout(() => {
			timedOut = true;
			proc.kill("SIGTERM");
			setTimeout(() => {
				if (!settled) proc.kill("SIGKILL");
			}, CHILD_VITEST_KILL_GRACE_MS);
		}, CHILD_VITEST_TIMEOUT_MS);
		proc.stdout.on("data", (d: Buffer) => {
			output += d.toString();
		});
		proc.stderr.on("data", (d: Buffer) => {
			output += d.toString();
		});
		proc.on("error", (error) => {
			output += `\n${error.name}: ${error.message}`;
			settle(1);
		});
		proc.on("exit", (code) => {
			settle(timedOut ? PROCESS_TIMEOUT_EXIT_CODE : (code ?? 1));
		});
	});
}

/**
 *
 */
function parseTestCounts(output: string): { passed: number; failed: number; total: number } {
	const passMatch = output.match(/Tests\s+(\d+) passed/);
	const failMatch = output.match(/(\d+) failed/);
	const passed = passMatch ? Number.parseInt(passMatch[1]!, 10) : 0;
	const failed = failMatch ? Number.parseInt(failMatch[1]!, 10) : 0;
	return { passed, failed, total: passed + failed };
}

/**
 *
 */
export function testCheck(globPattern = "**/*.test.ts"): Checker {
	void globPattern; // reserved for future filter support
	return {
		async check({ workspace }: CheckerContext): Promise<CheckerResult> {
			// Symlink node_modules so vitest and test imports resolve.
			const nm = join(workspace, "node_modules");
			if (!existsSync(nm)) {
				await symlink(MONOREPO_NODE_MODULES, nm, "dir").catch(() => {});
			}
			const tsconfig = join(workspace, "tsconfig.json");
			if (!existsSync(tsconfig)) {
				writeFileSync(tsconfig, buildEvalTsconfig(), "utf-8");
			}
			const vitestConfig = join(workspace, "vitest.config.ts");
			if (!existsSync(vitestConfig)) {
				writeFileSync(vitestConfig, buildEvalVitestConfig(), "utf-8");
			}

			const { exitCode, output } = await runVitest(workspace);
			const { passed, failed, total } = parseTestCounts(output);

			if (exitCode === 0) {
				return { pass: true, score: 1.0, errors: [] };
			}

			// Partial: some tests passed.
			if (passed > 0 && total > 0) {
				return {
					pass: false,
					score: passed / total,
					errors: [`${failed} of ${total} tests failed`],
				};
			}

			// Extract failure lines for diagnostics.
			const failLines = output
				.split("\n")
				.filter((l) => l.includes("FAIL") || l.includes("AssertionError") || l.includes("Error:"))
				// eslint-disable-next-line no-magic-numbers
				.slice(0, 5);

			return {
				pass: false,
				score: 0,
				errors: failLines.length > 0 ? failLines : [`vitest exited ${exitCode}`],
			};
		},
	};
}
