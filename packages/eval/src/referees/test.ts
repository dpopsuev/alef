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
import { existsSync } from "node:fs";
import { symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Referee, RefereeContext, RefereeResult } from "../evaluation.js";

const VITEST = join(dirname(fileURLToPath(import.meta.url)), "../../../../node_modules/.bin/vitest");

const MONOREPO_NODE_MODULES = join(dirname(fileURLToPath(import.meta.url)), "../../../../node_modules");

function runVitest(workspace: string): Promise<{ exitCode: number; output: string }> {
	return new Promise((resolve) => {
		const proc = spawn(VITEST, ["run", "--root", workspace, "--reporter", "verbose"], {
			cwd: workspace,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		proc.stdout.on("data", (d: Buffer) => {
			output += d.toString();
		});
		proc.stderr.on("data", (d: Buffer) => {
			output += d.toString();
		});
		proc.on("close", (code) => resolve({ exitCode: code ?? 1, output }));
	});
}

function parseTestCounts(output: string): { passed: number; failed: number; total: number } {
	const passMatch = output.match(/Tests\s+(\d+) passed/);
	const failMatch = output.match(/(\d+) failed/);
	const passed = passMatch ? Number.parseInt(passMatch[1], 10) : 0;
	const failed = failMatch ? Number.parseInt(failMatch[1], 10) : 0;
	return { passed, failed, total: passed + failed };
}

export function testCheck(globPattern = "**/*.test.ts"): Referee {
	void globPattern; // reserved for future filter support
	return {
		async check({ workspace }: RefereeContext): Promise<RefereeResult> {
			// Symlink node_modules so vitest and test imports resolve.
			const nm = join(workspace, "node_modules");
			if (!existsSync(nm)) {
				await symlink(MONOREPO_NODE_MODULES, nm, "dir").catch(() => {});
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
				.slice(0, 5);

			return {
				pass: false,
				score: 0,
				errors: failLines.length > 0 ? failLines : [`vitest exited ${exitCode}`],
			};
		},
	};
}
