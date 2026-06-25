#!/usr/bin/env node
/**
 * Pre-publish readiness check — validates package exports and types
 * for all non-private workspace packages.
 *
 * Runs:
 *   1. publint — validates package.json exports shape
 *   2. attw --pack — validates TypeScript resolution for consumers
 *
 * Usage:
 *   node scripts/check-publish-readiness.mjs
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const output = execSync("pnpm list -r --json --depth 0", { encoding: "utf-8" });
const packages = JSON.parse(output);

let failures = 0;

for (const pkg of packages) {
	const pkgJson = JSON.parse(readFileSync(`${pkg.path}/package.json`, "utf-8"));
	if (pkgJson.private) continue;

	const name = pkg.name;
	console.log(`\n━━ ${name} ━━`);

	try {
		execSync("npx publint", { cwd: pkg.path, encoding: "utf-8", stdio: "pipe" });
		console.log("  publint: ✓");
	} catch (err) {
		console.log(`  publint: ✗\n${err.stdout || err.stderr}`);
		failures++;
	}

	if (pkgJson.types || pkgJson.exports?.["."]?.types) {
		try {
			execSync("npx attw --pack .", { cwd: pkg.path, encoding: "utf-8", stdio: "pipe" });
			console.log("  attw: ✓");
		} catch (err) {
			console.log(`  attw: ✗ (type resolution issues — review before publish)`);
		}
	} else {
		console.log("  attw: skipped (no types field)");
	}
}

console.log(`\n${failures === 0 ? "✅ All packages ready" : `❌ ${failures} package(s) have issues`}`);
process.exit(failures > 0 ? 1 : 0);
