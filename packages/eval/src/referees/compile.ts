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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Referee, RefereeContext, RefereeResult } from "../evaluation.js";

const TSC = join(dirname(fileURLToPath(import.meta.url)), "../../../../node_modules/.bin/tsc");
const MONOREPO_NODE_MODULES = join(dirname(fileURLToPath(import.meta.url)), "../../../../node_modules");

const MINIMAL_TSCONFIG = JSON.stringify({
	compilerOptions: {
		strict: true,
		noEmit: true,
		target: "ESNext",
		module: "NodeNext",
		moduleResolution: "NodeNext",
		skipLibCheck: true,
		allowSyntheticDefaultImports: true,
	},
	include: ["**/*.ts"],
	exclude: ["node_modules"],
});

function runTsc(workspace: string): Promise<{ exitCode: number; output: string }> {
	return new Promise((resolve) => {
		const proc = spawn(TSC, ["--project", "tsconfig.json"], {
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

export function compileCheck(): Referee {
	return {
		async check({ workspace }: RefereeContext): Promise<RefereeResult> {
			// Symlink node_modules so @types/node and other typings resolve.
			const nm = join(workspace, "node_modules");
			if (!existsSync(nm)) {
				await symlink(MONOREPO_NODE_MODULES, nm, "dir").catch(() => {});
			}
			// Write minimal tsconfig if not present.
			const tsconfig = join(workspace, "tsconfig.json");
			if (!existsSync(tsconfig)) {
				writeFileSync(tsconfig, MINIMAL_TSCONFIG, "utf-8");
			}

			const { exitCode, output } = await runTsc(workspace);

			if (exitCode === 0) {
				return { pass: true, score: 1.0, errors: [] };
			}

			// Parse error lines for a clean error list.
			const errorLines = output
				.split("\n")
				.filter((l) => l.includes("error TS"))
				.slice(0, 10); // cap at 10 for readability

			return {
				pass: false,
				score: 0,
				errors: errorLines.length > 0 ? errorLines : [`tsc exited ${exitCode}`],
			};
		},
	};
}
