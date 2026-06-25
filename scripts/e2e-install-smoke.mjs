#!/usr/bin/env node
/**
 * E2E install smoke test — verifies that the agent package can be
 * installed globally and boots without crashing.
 *
 * Usage:
 *   node scripts/e2e-install-smoke.mjs          # test from local pack
 *   node scripts/e2e-install-smoke.mjs --npm    # test from npm registry
 */

import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FROM_NPM = process.argv.includes("--npm");

const testDir = mkdtempSync(join(tmpdir(), "alef-e2e-"));
console.log(`\n=== E2E Install Smoke Test ===`);
console.log(`  temp dir: ${testDir}`);
console.log(`  source: ${FROM_NPM ? "npm registry" : "local pack"}\n`);

function run(cmd, opts = {}) {
	console.log(`  $ ${cmd}`);
	return execSync(cmd, {
		encoding: "utf-8",
		cwd: opts.cwd ?? testDir,
		env: { ...process.env, npm_config_prefix: testDir },
		timeout: 60_000,
		...opts,
	});
}

let ok = true;

try {
	if (FROM_NPM) {
		run("npm install -g @dpopsuev/alef-runner");
	} else {
		const tarball = run("pnpm pack", { cwd: join(process.cwd(), "packages/agent") }).trim();
		const tarPath = join(process.cwd(), "packages/agent", tarball);
		run(`npm install -g "${tarPath}"`);
	}

	const binPath = join(testDir, "bin", "alef");
	if (!existsSync(binPath)) {
		console.error(`  ✗ bin/alef not found at ${binPath}`);
		ok = false;
	} else {
		console.log(`  ✓ bin/alef exists`);
	}

	const preflight = run(`"${binPath}" --preflight 2>&1 || true`);
	if (preflight.includes("Error:") && preflight.includes("Cannot find module")) {
		console.error(`  ✗ preflight failed with module resolution error:`);
		console.error(preflight.split("\n").slice(0, 5).join("\n"));
		ok = false;
	} else {
		console.log(`  ✓ preflight executed (exit without module crash)`);
	}

	const version = run(`"${binPath}" --version 2>&1 || true`).trim();
	if (version.includes("0.1.0")) {
		console.log(`  ✓ version: ${version}`);
	} else {
		console.log(`  ? version output: ${version.slice(0, 100)}`);
	}
} catch (err) {
	console.error(`  ✗ ${err.message}`);
	ok = false;
} finally {
	rmSync(testDir, { recursive: true, force: true });
}

console.log(`\n${ok ? "✅ E2E smoke test passed" : "❌ E2E smoke test failed"}`);
process.exit(ok ? 0 : 1);
