/**
 * coverageCheck — line coverage of files changed by the agent.
 *
 * Uses Node 22's built-in test runner with --experimental-test-coverage.
 * No extra packages needed. Runs the workspace test files and reports
 * coverage only for files the agent modified (not seed or unchanged files).
 *
 * Score:
 *   1.0 — all changed lines covered (100%)
 *   0.x — fraction of changed files meeting the threshold
 *   0.0 — no tests or coverage below 50%
 *
 * This is dynamic analysis: it actually executes the agent's code.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { symlink } from "node:fs/promises";
import { join } from "node:path";
import type { Checker, CheckerContext, CheckerResult } from "../evaluation.js";
import { getChangedFiles } from "../git-workspace.js";

const MONOREPO_NODE_MODULES = new URL("../../../../node_modules", import.meta.url).pathname;

interface CoverageEntry {
	file: string;
	linePct: number;
	branchPct: number;
}

/**
 *
 */
function parseCoverage(output: string): CoverageEntry[] {
	const entries: CoverageEntry[] = [];
	// Lines look like: # path/to/file.ts | 85.00 | 90.00 | 100.00 |
	const lineRe = /^#\s+(.+\.ts)\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)\s+\|/;
	for (const line of output.split("\n")) {
		const m = lineRe.exec(line);
		if (!m || !m[1] || !m[2] || !m[3]) continue;
		entries.push({
			file: m[1].trim(),
			linePct: parseFloat(m[2]),
			branchPct: parseFloat(m[3]),
		});
	}
	return entries;
}

/**
 *
 */
function runCoverage(workspace: string): Promise<{ output: string; exitCode: number }> {
	return new Promise((resolve) => {
		// Find test files in workspace.
		let output = "";
		const proc = spawn(
			process.execPath,
			["--experimental-test-coverage", "--test", "--test-reporter", "tap", "--test-name-pattern", "."],
			{
				cwd: workspace,
				stdio: ["ignore", "pipe", "pipe"],
				// Pass test glob via env — Node picks up *.test.ts|js automatically.
			},
		);
		proc.stdout.on("data", (d: Buffer) => {
			output += d.toString();
		});
		proc.stderr.on("data", (d: Buffer) => {
			output += d.toString();
		});
		proc.on("close", (code) => resolve({ output, exitCode: code ?? 1 }));
	});
}

/**
 *
 */
export interface CoverageCheckOptions {
	/** Seed SHA from initGitWorkspace(). Uses ctx.seedSha when omitted. */
	seedSha?: string;
	/** Minimum line coverage % required per changed file. Default: 70. */
	threshold?: number;
}

/**
 *
 */
export function coverageCheck(opts?: Partial<CoverageCheckOptions>): Checker {
	return {
		async check({ workspace, seedSha: ctxSeedSha }: CheckerContext): Promise<CheckerResult> {
			const resolvedSha = opts?.seedSha ?? ctxSeedSha;
			// eslint-disable-next-line no-magic-numbers
			const threshold = opts?.threshold ?? 70;

			if (!resolvedSha) return { pass: true, score: 1.0, errors: [] };

			const changedSrc = getChangedFiles(workspace, resolvedSha).filter(
				(f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
			);

			if (changedSrc.length === 0) return { pass: true, score: 1.0, errors: [] };

			// Symlink node_modules so test imports resolve.
			const nm = join(workspace, "node_modules");
			if (!existsSync(nm)) {
				await symlink(MONOREPO_NODE_MODULES, nm, "dir").catch(() => {});
			}

			const { output } = await runCoverage(workspace);
			const allEntries = parseCoverage(output);

			// Match coverage entries to changed source files (path suffix match).
			const errors: string[] = [];
			let covered = 0;

			for (const srcFile of changedSrc) {
				const entry = allEntries.find((e) => e.file.endsWith(srcFile) || srcFile.endsWith(e.file));
				if (!entry) {
					errors.push(`${srcFile}: no coverage data (no test imports this file?)`);
					continue;
				}
				if (entry.linePct >= threshold) {
					covered++;
				} else {
					errors.push(`${srcFile}: ${entry.linePct.toFixed(0)}% line coverage (threshold ${threshold}%)`);
				}
			}

			const score = changedSrc.length > 0 ? covered / changedSrc.length : 1.0;
			return { pass: errors.length === 0, score, errors };
		},
	};
}
