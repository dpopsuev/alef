/**
 * propertyCheck — verifies mathematical invariants of the agent's code at runtime.
 *
 * The harness seeds a property test file into the workspace that the agent
 * never touches. The file imports the agent's module and asserts invariants
 * using Node.js's built-in test runner (no extra packages).
 *
 * A "property" is a statement that must hold for ALL inputs in a range, not
 * just the specific inputs in the seed test file. This catches bugs that
 * pass the seed tests but fail on boundary or random inputs.
 *
 * Example for sum():
 *   - identity: sum([]) === 0
 *   - singleton: sum([n]) === n  ∀ n
 *   - commutativity: sum([a,b]) === sum([b,a])  ∀ a,b
 *
 * Score:
 *   1.0 — all properties hold
 *   partial — fraction of properties that hold
 *   0.0 — all fail or runner error
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Checker, CheckerContext, CheckerResult } from "../evaluation.js";

const MONOREPO_NODE_MODULES = new URL("../../../../node_modules", import.meta.url).pathname;

export interface Property {
	/** Human-readable name used in error messages. */
	name: string;
	/**
	 * TypeScript/ESM test body. Written into a property.test.ts file.
	 * Must import the module under test relative to the workspace root.
	 * Must call assert.ok() or assert.strictEqual() from 'node:assert'.
	 *
	 * @example
	 * `import { sum } from './src/sum.js';
	 *  import assert from 'node:assert';
	 *  for (let i = 0; i < 100; i++) {
	 *    const n = Math.floor(Math.random() * 200 - 100);
	 *    assert.strictEqual(sum([n]), n, \`singleton: sum([${n}]) should be ${n}\`);
	 *  }`
	 */
	body: string;
}

function buildPropertyFile(properties: Property[]): string {
	const blocks = properties.map((p) => `test(${JSON.stringify(p.name)}, () => {\n${p.body}\n});`);
	return [`import { test } from 'node:test';`, `import assert from 'node:assert';`, ``, ...blocks].join("\n");
}

function runPropertyTests(workspace: string): Promise<{ passed: number; failed: number; output: string }> {
	return new Promise((resolve) => {
		let output = "";
		const proc = spawn(process.execPath, ["--test", "--test-reporter", "tap", "property.test.mjs"], {
			cwd: workspace,
			stdio: ["ignore", "pipe", "pipe"],
		});
		proc.stdout.on("data", (d: Buffer) => {
			output += d.toString();
		});
		proc.stderr.on("data", (d: Buffer) => {
			output += d.toString();
		});
		proc.on("close", () => {
			const passed = (output.match(/^ok \d+/gm) ?? []).length;
			const failed = (output.match(/^not ok \d+/gm) ?? []).length;
			resolve({ passed, failed, output });
		});
	});
}

export function propertyCheck(properties: Property[]): Checker {
	return {
		async check({ workspace }: CheckerContext): Promise<CheckerResult> {
			if (properties.length === 0) return { pass: true, score: 1.0, errors: [] };

			// Symlink node_modules.
			const nm = join(workspace, "node_modules");
			if (!existsSync(nm)) {
				await symlink(MONOREPO_NODE_MODULES, nm, "dir").catch(() => {});
			}

			// Seed the property test file (ESM .mjs so Node loads it directly).
			const content = buildPropertyFile(properties);
			await writeFile(join(workspace, "property.test.mjs"), content, "utf-8");

			const { passed, failed, output } = await runPropertyTests(workspace);
			const total = passed + failed;

			if (total === 0) {
				return {
					pass: false,
					score: 0,
					errors: ["Property test file produced no test results — check module imports"],
				};
			}

			const score = passed / total;
			const failLines = output
				.split("\n")
				.filter((l) => l.startsWith("not ok") || l.includes("AssertionError") || l.includes("# "))
				.slice(0, 5);

			return {
				pass: failed === 0,
				score,
				errors: failed > 0 ? failLines : [],
			};
		},
	};
}

// ---------------------------------------------------------------------------
// Built-in property sets for common patterns
// ---------------------------------------------------------------------------

/** Standard mathematical properties for a sum(numbers: number[]): number function. */
export const SUM_PROPERTIES: Property[] = [
	{
		name: "identity: sum([]) === 0",
		body: `import { sum } from './src/sum.js';
const result = sum([]);
assert.strictEqual(result, 0, \`sum([]) should be 0, got \${result}\`);`,
	},
	{
		name: "singleton: sum([n]) === n for 50 random values",
		body: `import { sum } from './src/sum.js';
for (let i = 0; i < 50; i++) {
  const n = Math.floor(Math.random() * 2000 - 1000);
  assert.strictEqual(sum([n]), n, \`sum([\${n}]) should be \${n}\`);
}`,
	},
	{
		name: "commutativity: sum([a,b]) === sum([b,a])",
		body: `import { sum } from './src/sum.js';
for (let i = 0; i < 100; i++) {
  const a = Math.floor(Math.random() * 200 - 100);
  const b = Math.floor(Math.random() * 200 - 100);
  assert.strictEqual(sum([a, b]), sum([b, a]), \`commutativity failed for [\${a},\${b}]\`);
}`,
	},
	{
		name: "associativity: sum([a,b,c]) === sum([a]) + sum([b,c])",
		body: `import { sum } from './src/sum.js';
for (let i = 0; i < 100; i++) {
  const a = Math.floor(Math.random() * 100);
  const b = Math.floor(Math.random() * 100);
  const c = Math.floor(Math.random() * 100);
  assert.strictEqual(sum([a, b, c]), sum([a]) + sum([b, c]),
    \`associativity failed for [\${a},\${b},\${c}]\`);
}`,
	},
];
