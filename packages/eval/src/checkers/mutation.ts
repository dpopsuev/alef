/**
 * mutationCheck — verifies the test suite catches deliberate bugs.
 *
 * For each mutation:
 *   1. Apply the mutation to a file in the workspace (shell: write mutated content)
 *   2. Run the tests — they MUST fail (if they pass, the tests missed the bug)
 *   3. Restore the original file
 *
 * Mutation score = caught / total mutations.
 * A mutation is "caught" when the test suite exits non-zero.
 *
 * Dynamic analysis: actually executes the mutated code. Proves the test
 * suite is meaningful — not just "tests pass" but "tests would catch regressions."
 *
 * Uses shell in the workspace (throwaway temp dir). No DockerSpace needed
 * because each vitest invocation is a fresh child process — no module cache
 * carries over between runs.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Checker, CheckerContext, CheckerResult } from "../evaluation.js";

const VITEST = join(fileURLToPath(import.meta.url), "../../../../..", "node_modules/.bin/vitest");

const MONOREPO_NODE_MODULES = join(fileURLToPath(import.meta.url), "../../../../node_modules");

export interface Mutation {
	/** Human-readable name: what bug is being introduced. */
	name: string;
	/** Path to the file to mutate, relative to workspace root. */
	file: string;
	/** The mutated file content — replaces the original for the test run. */
	mutatedContent: string;
}

/** Convenience: create a mutation by string substitution on the current file. */
export function substitutionMutation(
	name: string,
	file: string,
	workspace: string,
	from: string | RegExp,
	to: string,
): Mutation {
	const original = readFileSync(join(workspace, file), "utf-8");
	const mutated = original.replace(from, to);
	return { name, file, mutatedContent: mutated };
}

function runVitest(workspace: string): Promise<{ exitCode: number }> {
	return new Promise((resolve) => {
		const proc = spawn(VITEST, ["run", "--root", workspace], {
			cwd: workspace,
			stdio: ["ignore", "pipe", "pipe"],
		});
		proc.stdout.on("data", () => {});
		proc.stderr.on("data", () => {});
		proc.on("close", (code) => resolve({ exitCode: code ?? 1 }));
	});
}

export function mutationCheck(mutations: Mutation[]): Checker {
	return {
		async check({ workspace }: CheckerContext): Promise<CheckerResult> {
			if (mutations.length === 0) return { pass: true, score: 1.0, errors: [] };

			// Symlink node_modules so vitest resolves.
			const nm = join(workspace, "node_modules");
			if (!existsSync(nm)) {
				await symlink(MONOREPO_NODE_MODULES, nm, "dir").catch(() => {});
			}

			const escaped: string[] = [];
			let caught = 0;

			for (const mutation of mutations) {
				const filePath = join(workspace, mutation.file);

				// Safety: don't proceed if the file doesn't exist.
				if (!existsSync(filePath)) {
					escaped.push(`${mutation.name}: file not found (${mutation.file})`);
					continue;
				}

				const original = readFileSync(filePath, "utf-8");

				// Skip if mutation is identical to original (no change introduced).
				if (original === mutation.mutatedContent) {
					escaped.push(`${mutation.name}: mutation produced no change — check the substitution`);
					continue;
				}

				try {
					// Apply mutation.
					writeFileSync(filePath, mutation.mutatedContent, "utf-8");

					// Run tests — must fail.
					const { exitCode } = await runVitest(workspace);

					if (exitCode !== 0) {
						// Tests failed = mutation caught. Good.
						caught++;
					} else {
						// Tests passed on broken code = mutation escaped. Bad.
						escaped.push(`${mutation.name}: tests PASSED on mutated code — test coverage gap`);
					}
				} finally {
					// Always restore original.
					writeFileSync(filePath, original, "utf-8");
				}
			}

			const score = mutations.length > 0 ? caught / mutations.length : 1.0;
			return { pass: escaped.length === 0, score, errors: escaped };
		},
	};
}

// ---------------------------------------------------------------------------
// Built-in mutation sets for common patterns
// ---------------------------------------------------------------------------

/**
 * Mutations for the sum() eval scenario.
 * Each re-introduces a plausible bug that the agent's tests must catch.
 * Provide the workspace path at checker creation time.
 */
export function sumMutations(workspace: string): Mutation[] {
	const file = "src/sum.ts";
	return [
		{
			name: "off-by-one: <= instead of <",
			file,
			mutatedContent: readFileSync(join(workspace, file), "utf-8").replace(
				/i\s*<\s*numbers\.length/,
				"i <= numbers.length",
			),
		},
		{
			name: "wrong initial value: total = 1 instead of 0",
			file,
			mutatedContent: readFileSync(join(workspace, file), "utf-8").replace(/let total\s*=\s*0/, "let total = 1"),
		},
		{
			name: "subtraction instead of addition",
			file,
			mutatedContent: readFileSync(join(workspace, file), "utf-8").replace(
				/total\s*\+=\s*numbers\[i\]/,
				"total -= numbers[i]",
			),
		},
		{
			name: "return zero always",
			file,
			mutatedContent: readFileSync(join(workspace, file), "utf-8").replace(/return total/, "return 0"),
		},
	].filter((m) => m.mutatedContent !== readFileSync(join(workspace, file), "utf-8"));
}
