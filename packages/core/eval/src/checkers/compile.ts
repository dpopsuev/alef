/**
 * CompileReferee — verifies TypeScript files in the workspace compile cleanly.
 *
 * Writes a minimal tsconfig.json if one is not already present.
 * Runs the monorepo's tsc binary with --noEmit.
 *
 * Score:
 *   1.0 — zero type errors
 *   0.0 — any type errors (output included in errors[])
 *
 * skipLibCheck: true — avoids failures from missing node_modules type decls
 * in isolated workspaces. The check is structural, not import-graph complete.
 */

import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { symlink } from "node:fs/promises";
import { join } from "node:path";
import type { Checker, CheckerContext, CheckerResult } from "../evaluation.js";
import { buildEvalTsconfig, monorepoNodeModulesPath, monorepoPath } from "./tooling-paths.js";

const TSC = monorepoPath("node_modules", ".bin", "tsc");
const MONOREPO_NODE_MODULES = monorepoNodeModulesPath();
const EVAL_TSCONFIG_NAME = "tsconfig.alef-eval.json";

/**
 *
 */
function runTsc(workspace: string, projectFile: string): Promise<{ exitCode: number; output: string }> {
	return new Promise((resolve) => {
		let settled = false;
		const settle = (exitCode: number, output: string): void => {
			if (settled) return;
			settled = true;
			resolve({ exitCode, output });
		};
		const proc = spawn(TSC, ["--project", projectFile], {
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
		proc.on("error", (error) => {
			output += `\n${error.name}: ${error.message}`;
			settle(1, output);
		});
		proc.on("close", (code) => {
			settle(code ?? 1, output);
		});
	});
}

/**
 *
 */
export function compileCheck(): Checker {
	return {
		async check({ workspace }: CheckerContext): Promise<CheckerResult> {
			// Symlink node_modules so @types/node and other typings resolve.
			const nm = join(workspace, "node_modules");
			if (!existsSync(nm)) {
				await symlink(MONOREPO_NODE_MODULES, nm, "dir").catch(() => {});
			}
			// Write minimal tsconfig if not present.
			const tsconfig = join(workspace, "tsconfig.json");
			if (!existsSync(tsconfig)) {
				writeFileSync(tsconfig, buildEvalTsconfig(), "utf-8");
			}
			const evalTsconfig = join(workspace, EVAL_TSCONFIG_NAME);
			writeFileSync(
				evalTsconfig,
				JSON.stringify({
					extends: "./tsconfig.json",
					compilerOptions: {
						types: ["node"],
						skipLibCheck: true,
					},
				}),
				"utf-8",
			);

			const { exitCode, output } = await runTsc(workspace, EVAL_TSCONFIG_NAME);

			if (exitCode === 0) {
				return { pass: true, score: 1.0, errors: [] };
			}

			// Parse error lines for a clean error list.
			const errorLines = output
				.split("\n")
				.filter((l) => l.includes("error TS"))
				// eslint-disable-next-line no-magic-numbers
				.slice(0, 10); // cap at 10 for readability

			return {
				pass: false,
				score: 0,
				errors: errorLines.length > 0 ? errorLines : [`tsc exited ${exitCode}`],
			};
		},
	};
}
