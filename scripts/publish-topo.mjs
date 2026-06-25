#!/usr/bin/env node
/**
 * Topological publish — publishes workspace packages in dependency order.
 *
 * Only publishes versions not yet on the registry (from-package semantics).
 * Throttles between publishes to avoid npm 429 rate limits (~25/window).
 *
 * Usage:
 *   node scripts/publish-topo.mjs            # dry-run (default)
 *   node scripts/publish-topo.mjs --publish  # publish for real
 *
 * Env:
 *   PUBLISH_THROTTLE_MS  delay between publishes (default: 30000)
 *   PUBLISH_BATCH_SIZE   packages per batch before long pause (default: 20)
 *   PUBLISH_BATCH_PAUSE  pause between batches in ms (default: 60000)
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DRY_RUN = !process.argv.includes("--publish");
const THROTTLE_MS = Number(process.env.PUBLISH_THROTTLE_MS ?? 30000);
const BATCH_SIZE = Number(process.env.PUBLISH_BATCH_SIZE ?? 20);
const BATCH_PAUSE = Number(process.env.PUBLISH_BATCH_PAUSE ?? 60000);
const MAX_RETRIES = 5;

// ---------------------------------------------------------------------------
// Workspace discovery + topo sort
// ---------------------------------------------------------------------------

const workspaceOutput = execSync("pnpm list -r --json --depth 0", { encoding: "utf-8", stdio: "pipe" });
const packages = JSON.parse(workspaceOutput);

const pkgMap = new Map();
for (const pkg of packages) {
	const pkgJson = JSON.parse(readFileSync(join(pkg.path, "package.json"), "utf-8"));
	if (pkgJson.private) continue;
	pkgMap.set(pkg.name, { name: pkg.name, path: pkg.path, version: pkgJson.version, deps: new Set() });
}

for (const pkg of packages) {
	if (!pkgMap.has(pkg.name)) continue;
	const pkgJson = JSON.parse(readFileSync(join(pkg.path, "package.json"), "utf-8"));
	const allDeps = { ...pkgJson.dependencies, ...pkgJson.peerDependencies };
	for (const dep of Object.keys(allDeps)) {
		if (pkgMap.has(dep)) pkgMap.get(pkg.name).deps.add(dep);
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
		for (const dep of graph.get(name)?.deps ?? []) visit(dep);
		visiting.delete(name);
		visited.add(name);
		sorted.push(name);
	}
	for (const name of graph.keys()) visit(name);
	return sorted;
}

// ---------------------------------------------------------------------------
// Registry check — only publish what's missing
// ---------------------------------------------------------------------------

function isPublished(name, version) {
	try {
		const out = execSync(`npm view ${name}@${version} version`, { encoding: "utf-8", stdio: "pipe" }).trim();
		return out === version;
	} catch { return false; }
}

// ---------------------------------------------------------------------------
// Publish with throttle + retry
// ---------------------------------------------------------------------------

const order = topoSort(pkgMap);

// Pre-scan: filter to unpublished only
const toPublish = [];
for (const name of order) {
	const pkg = pkgMap.get(name);
	if (!DRY_RUN && isPublished(name, pkg.version)) {
		console.log(`  ✓ ${name}@${pkg.version} (already on npm)`);
	} else {
		toPublish.push(name);
	}
}

console.log(`\n=== ${DRY_RUN ? "Dry Run" : "Publishing"}: ${toPublish.length} packages (${order.length - toPublish.length} already on npm) ===\n`);

let batchCount = 0;

for (let i = 0; i < toPublish.length; i++) {
	const name = toPublish[i];
	const pkg = pkgMap.get(name);
	console.log(`[${i + 1}/${toPublish.length}] ${name}@${pkg.version}`);

	const cmd = DRY_RUN
		? `pnpm publish --dry-run --no-git-checks`
		: `pnpm publish --no-git-checks --access public`;

	let retries = 0;
	while (retries < MAX_RETRIES) {
		try {
			execSync(cmd, { cwd: pkg.path, encoding: "utf-8", stdio: "pipe" });
			batchCount++;

			if (DRY_RUN) {
				console.log("  (dry-run OK)");
			} else {
				console.log(`  ✓ published`);

				if (batchCount >= BATCH_SIZE && i < toPublish.length - 1) {
					console.log(`  --- batch of ${BATCH_SIZE} done, pausing ${BATCH_PAUSE / 1000}s ---`);
					await new Promise(r => setTimeout(r, BATCH_PAUSE));
					batchCount = 0;
				} else if (i < toPublish.length - 1) {
					await new Promise(r => setTimeout(r, THROTTLE_MS));
				}
			}
			break;
		} catch (err) {
			const msg = `${err.message ?? ""} ${err.stderr?.toString() ?? ""}`;

			if (msg.includes("E429") || msg.includes("rate limit")) {
				retries++;
				const retryAfterMatch = msg.match(/retry-after[:\s]+(\d+)/i);
				const wait = retryAfterMatch ? Number(retryAfterMatch[1]) : retries * 60;
				console.log(`  ⏳ rate limited (retry ${retries}/${MAX_RETRIES}, waiting ${wait}s)`);
				await new Promise(r => setTimeout(r, wait * 1000));
			} else {
				console.error(`  ✗ FAILED: ${msg.slice(0, 200)}`);
				process.exit(1);
			}
		}
	}

	if (retries >= MAX_RETRIES) {
		console.error(`  ✗ gave up after ${MAX_RETRIES} retries`);
		process.exit(1);
	}
}

console.log(`\n=== ${DRY_RUN ? "Dry run complete" : `Done — ${toPublish.length} packages published`} ===`);
