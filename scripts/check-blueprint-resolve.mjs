#!/usr/bin/env node

/**
 * Verify every organ package referenced in blueprint YAMLs has a
 * directory in node_modules — catches missing workspace links.
 *
 * Uses existsSync on node_modules path rather than require.resolve,
 * because workspace packages export raw .ts source (no dist/ build).
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const PACKAGES_DIR = "packages";
const NODE_MODULES = "node_modules";
const failures = [];
let checked = 0;

for (const entry of readdirSync(PACKAGES_DIR, { withFileTypes: true })) {
	if (!entry.isDirectory()) continue;
	const blueprintPath = join(PACKAGES_DIR, entry.name, "blueprint.yaml");
	if (!existsSync(blueprintPath)) continue;

	const content = readFileSync(blueprintPath, "utf-8");
	const blueprint = parse(content);
	if (!blueprint?.organs || !Array.isArray(blueprint.organs)) continue;

	for (const organ of blueprint.organs) {
		const pkg = organ.package ?? organ.name;
		if (!pkg) continue;

		// Resolve: explicit package name, or convention @dpopsuev/alef-adapter-{name}
		const packageName = pkg.startsWith("@") ? pkg : `@dpopsuev/alef-adapter-${pkg}`;
		const scopeDir = packageName.startsWith("@")
			? join(NODE_MODULES, packageName.split("/")[0], packageName.split("/")[1])
			: join(NODE_MODULES, packageName);
		checked++;

		if (!existsSync(scopeDir)) {
			failures.push({ blueprint: blueprintPath, package: packageName, dir: scopeDir });
		}
	}
}

if (failures.length > 0) {
	console.error(`\n❌ ${failures.length}/${checked} blueprint organ(s) not in node_modules:\n`);
	for (const f of failures) {
		console.error(`  ${f.blueprint}: ${f.package}`);
		console.error(`    expected: ${f.dir}\n`);
	}
	console.error("Fix: run 'npm install' to link workspace packages.\n");
	process.exit(1);
}

console.log(`✅ All ${checked} blueprint organ packages found in node_modules`);
