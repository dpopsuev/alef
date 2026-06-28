#!/usr/bin/env node
/**
 * E2E install smoke test.
 *
 * Two modes:
 *   node scripts/e2e-install-smoke.mjs          # pre-publish: validate tarball
 *   node scripts/e2e-install-smoke.mjs --npm    # post-publish: real install from npm
 */

import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FROM_NPM = process.argv.includes("--npm");

const testDir = mkdtempSync(join(tmpdir(), "alef-e2e-"));
console.log(`\n=== E2E Install Smoke Test ===`);
console.log(`  temp dir: ${testDir}`);
console.log(`  mode: ${FROM_NPM ? "post-publish (npm registry)" : "pre-publish (tarball validation)"}\n`);

function run(cmd, opts = {}) {
	console.log(`  $ ${cmd}`);
	return execSync(cmd, {
		encoding: "utf-8",
		cwd: opts.cwd ?? testDir,
		timeout: 60_000,
		...opts,
	});
}

let ok = true;
function check(label, pass) {
	console.log(`  ${pass ? "✓" : "✗"} ${label}`);
	if (!pass) ok = false;
}

try {
	if (FROM_NPM) {
		run(`npm install -g @dpopsuev/alef`, { env: { ...process.env, npm_config_prefix: testDir } });

		const binPath = join(testDir, "bin", "alef");
		check("bin/alef exists", existsSync(binPath));

		if (existsSync(binPath)) {
			const preflight = run(`"${binPath}" --preflight 2>&1 || true`, {
				env: { ...process.env, npm_config_prefix: testDir },
			});
			const crashed = preflight.includes("Cannot find module");
			check("preflight boots without module crash", !crashed);
			if (crashed) console.error(preflight.split("\n").slice(0, 5).join("\n"));
		}
	} else {
		const agentDir = join(process.cwd(), "packages/cli");
		const packOutput = run("pnpm pack", { cwd: agentDir });
		const tarball = packOutput.split("\n").filter(l => l.endsWith(".tgz"))[0]?.trim();
		check("pnpm pack produced a .tgz", !!tarball);
		if (!tarball) throw new Error("pnpm pack did not produce a .tgz file");

		const tarPath = join(agentDir, tarball);
		check("tarball exists on disk", existsSync(tarPath));

		const extractDir = join(testDir, "extract");
		run(`mkdir -p ${extractDir}`);
		run(`tar xzf "${tarPath}" -C "${extractDir}"`);

		const pkgDir = join(extractDir, "package");
		check("package/ directory in tarball", existsSync(pkgDir));

		check("bin/alef.js in tarball", existsSync(join(pkgDir, "bin/alef.js")));
		check("dist/supervisor.js in tarball", existsSync(join(pkgDir, "dist/supervisor.js")));
		check("dist/cli/main.js in tarball", existsSync(join(pkgDir, "dist/cli/main.js")));
		check("dist/build-info.js in tarball", existsSync(join(pkgDir, "dist/build-info.js")));

		const pkgJson = JSON.parse(run(`cat "${join(pkgDir, "package.json")}"`, { silent: true }));
		check("package.json name is @dpopsuev/alef", pkgJson.name === "@dpopsuev/alef");
		check("package.json bin.alef points to bin/alef.js", pkgJson.bin?.alef === "bin/alef.js");
		check("publishConfig.access is public", pkgJson.publishConfig?.access === "public");

		const hasWorkspaceDeps = Object.values(pkgJson.dependencies || {}).some(v => v.includes("workspace:"));
		check("no workspace: deps in packed tarball", !hasWorkspaceDeps);

		rmSync(tarPath, { force: true });
	}
} catch (err) {
	console.error(`  ✗ ${err.message}`);
	ok = false;
} finally {
	rmSync(testDir, { recursive: true, force: true });
}

console.log(`\n${ok ? "✅ E2E smoke test passed" : "❌ E2E smoke test failed"}`);
process.exit(ok ? 0 : 1);
