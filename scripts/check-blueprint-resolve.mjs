#!/usr/bin/env node

/**
 * Verify every adapter package in blueprint YAMLs is loadable the same way
 * materializer.ts loads them: npm resolve from @dpopsuev/alef-blueprint, or
 * monorepo packages/tools/<name>/src/index.ts fallback.
 *
 * Scans packages/ recursively for blueprint.yaml (including packages/profiles/).
 */

import { createRequire } from "node:module";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES_DIR = join(ROOT, "packages");
const MATERIALIZER_HOST = join(ROOT, "packages/core/blueprint/package.json");
const requireFromMaterializer = createRequire(MATERIALIZER_HOST);

/**
 * @param {string} dir
 * @returns {Generator<string>}
 */
function* walkBlueprints(dir) {
	if (!existsSync(dir)) return;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			yield* walkBlueprints(path);
			continue;
		}
		if (entry.name === "blueprint.yaml") yield path;
	}
}

/**
 * @param {string} pkg
 */
function resolvePackageName(pkg) {
	if (pkg.startsWith("@") || pkg.startsWith("file:")) return pkg;
	return `@dpopsuev/alef-tool-${pkg}`;
}

/**
 * @param {string} packageName
 */
function canResolve(packageName) {
	try {
		requireFromMaterializer.resolve(packageName);
		return true;
	} catch {
		const match = /^@dpopsuev\/alef-tool-(.+)$/.exec(packageName);
		if (!match?.[1]) return false;
		return existsSync(join(ROOT, "packages", "tools", match[1], "src", "index.ts"));
	}
}

const failures = [];
let checked = 0;
const blueprints = [...walkBlueprints(PACKAGES_DIR)];

if (blueprints.length === 0) {
	console.error("❌ No blueprint.yaml files found under packages/");
	process.exit(1);
}

for (const blueprintPath of blueprints) {
	const blueprint = parse(readFileSync(blueprintPath, "utf-8"));
	if (!blueprint?.adapters || !Array.isArray(blueprint.adapters)) continue;

	for (const adapter of blueprint.adapters) {
		const pkg = adapter.package ?? adapter.name;
		if (!pkg || typeof pkg !== "string") continue;

		const packageName = resolvePackageName(pkg);
		checked++;

		if (!canResolve(packageName)) {
			failures.push({
				blueprint: relative(ROOT, blueprintPath),
				package: packageName,
			});
		}
	}
}

if (failures.length > 0) {
	console.error(`\n❌ ${failures.length}/${checked} blueprint adapter(s) not resolvable:\n`);
	for (const failure of failures) {
		console.error(`  ${failure.blueprint}: ${failure.package}`);
	}
	console.error("\nExpected either:");
	console.error("  - resolvable from packages/core/blueprint (pnpm link / dependency), or");
	console.error("  - packages/tools/<name>/src/index.ts in this monorepo");
	console.error('Fix: add the workspace package and run PATH="/usr/bin:$PATH" pnpm install\n');
	process.exit(1);
}

console.log(
	`✅ All ${checked} adapter package(s) across ${blueprints.length} blueprint(s) resolve for materializer`,
);
