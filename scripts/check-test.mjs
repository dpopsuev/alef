#!/usr/bin/env node
/**
 * Run unit tests across all packages that have a vitest config.
 * Uses --tags-filter="unit" to exclude slow/flaky tests (e2e, real-llm,
 * render-stress, smoke-tui, integration).
 *
 * Known pre-existing failures are baselined and do not block commit.
 * New failures (packages not in baseline) do block commit.
 *
 * To update the baseline after fixing pre-existing failures:
 *   node scripts/check-test.mjs --update-baseline
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const packagesDir = join(root, "packages");
const baselineFile = join(root, "scripts", "check-test-baseline.json");

const updateBaseline = process.argv.includes("--update-baseline");

const packages = readdirSync(packagesDir)
	.map((name) => ({ name, dir: join(packagesDir, name) }))
	.filter(({ dir }) => existsSync(join(dir, "vitest.config.ts")));

const results = await Promise.all(
	packages.map(
		({ name, dir }) =>
			new Promise((resolve) => {
				const child = spawn("npx", ["vitest", "run", "--reporter=dot", "--tags-filter=unit"], {
					cwd: dir,
					stdio: "pipe",
				});
				let output = "";
				child.stdout.on("data", (d) => { output += d; });
				child.stderr.on("data", (d) => { output += d; });
				child.on("close", (code) => resolve({ name, code, output }));
				setTimeout(() => { child.kill(); resolve({ name, code: 1, output: "timeout" }); }, 60_000);
			}),
	),
);

const failed = results.filter((r) => r.code !== 0).map((r) => r.name).sort();
const passed = results.filter((r) => r.code === 0).map((r) => r.name);

if (updateBaseline) {
	writeFileSync(baselineFile, JSON.stringify({ knownFailing: failed }, null, "\t"));
	console.log(`Updated baseline: ${failed.length} known-failing packages`);
	console.log(failed.join(", ") || "(none)");
	process.exit(0);
}

const baseline = existsSync(baselineFile)
	? JSON.parse(readFileSync(baselineFile, "utf-8")).knownFailing
	: [];

const newFailures = failed.filter((name) => !baseline.includes(name));
const fixed = baseline.filter((name) => !failed.includes(name));

for (const name of newFailures) {
	const result = results.find((r) => r.name === name);
	console.error(`\n── ${name} (NEW FAILURE) ──`);
	const lines = result.output.split("\n").filter((l) => l.trim());
	const relevant = lines.filter((l) =>
		l.includes("FAIL") || l.includes("AssertionError") || l.includes("Error:") || l.includes("×"),
	);
	for (const line of relevant.slice(0, 10)) console.error(line);
}

if (fixed.length > 0) {
	console.log(`\n✓ Fixed: ${fixed.join(", ")} — run --update-baseline to shrink the baseline`);
}

console.log(`\n${passed.length}/${packages.length} packages passed`);
if (baseline.length > 0) {
	console.log(`  ${baseline.length} known-failing (baselined): ${baseline.join(", ")}`);
}

if (newFailures.length > 0) {
	console.error(`❌ New test failures: ${newFailures.join(", ")}`);
	process.exit(1);
}

console.log("✅ No new test failures");
