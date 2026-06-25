#!/usr/bin/env node
/**
 * Topological publish — publishes all non-private workspace packages
 * in dependency order (leaves first).
 *
 * Usage:
 *   node scripts/publish-topo.mjs            # dry-run (default)
 *   node scripts/publish-topo.mjs --publish  # publish for real
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DRY_RUN = !process.argv.includes("--publish");

function run(cmd, opts = {}) {
	console.log(`  $ ${cmd}`);
	return execSync(cmd, { encoding: "utf-8", stdio: opts.silent ? "pipe" : "inherit", ...opts });
}

const workspaceOutput = run("pnpm list -r --json --depth 0", { silent: true });
const packages = JSON.parse(workspaceOutput);

const pkgMap = new Map();
for (const pkg of packages) {
	if (pkg.private) continue;
	const pkgJson = JSON.parse(readFileSync(join(pkg.path, "package.json"), "utf-8"));
	if (pkgJson.private) continue;
	pkgMap.set(pkg.name, { name: pkg.name, path: pkg.path, deps: new Set() });
}

for (const pkg of packages) {
	if (!pkgMap.has(pkg.name)) continue;
	const pkgJson = JSON.parse(readFileSync(join(pkg.path, "package.json"), "utf-8"));
	const allDeps = { ...pkgJson.dependencies, ...pkgJson.peerDependencies };
	for (const dep of Object.keys(allDeps)) {
		if (pkgMap.has(dep)) {
			pkgMap.get(pkg.name).deps.add(dep);
		}
	}
}

function topoSort(graph) {
	const sorted = [];
	const visited = new Set();
	const visiting = new Set();

	function visit(name) {
		if (visited.has(name)) return;
		if (visiting.has(name)) throw new Error(`Dependency cycle: ${name}`);
		visiting.add(name);
		const node = graph.get(name);
		if (node) {
			for (const dep of node.deps) visit(dep);
		}
		visiting.delete(name);
		visited.add(name);
		sorted.push(name);
	}

	for (const name of graph.keys()) visit(name);
	return sorted;
}

const order = topoSort(pkgMap);

console.log(`\n=== ${DRY_RUN ? "Dry Run" : "Publishing"} ${order.length} packages ===\n`);

for (const name of order) {
	const pkg = pkgMap.get(name);
	console.log(`\n[${order.indexOf(name) + 1}/${order.length}] ${name}`);
	const cmd = DRY_RUN
		? `pnpm publish --dry-run --no-git-checks`
		: `pnpm publish --no-git-checks --access public`;
	try {
		run(cmd, { cwd: pkg.path, silent: DRY_RUN });
	} catch (err) {
		if (DRY_RUN) {
			console.log(`  (dry-run OK)`);
		} else {
			console.error(`  FAILED: ${err.message}`);
			process.exit(1);
		}
	}
}

console.log(`\n=== ${DRY_RUN ? "Dry run complete" : "All packages published"} ===`);
