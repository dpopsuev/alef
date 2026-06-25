#!/usr/bin/env node
/**
 * Generate tsconfig.build.json with composite + project references for all workspace packages.
 *
 * Build configs extend tsconfig.base.json (NOT tsconfig.json) — no path aliases.
 * Module resolution happens via pnpm workspace symlinks + package.json exports/types.
 * References are production deps only (devDeps excluded to avoid cycles).
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const pkgMap = new Map();
const pkgDirs = [];

function findPackages(base, depth = 0) {
	if (depth > 3) return;
	for (const entry of readdirSync(base, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name === "dist") continue;
		const full = join(base, entry.name);
		if (entry.isDirectory()) {
			const pkgPath = join(full, "package.json");
			if (existsSync(pkgPath)) {
				try {
					const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
					if (pkg.name) {
						const relDir = relative(ROOT, full);
						pkgMap.set(pkg.name, { dir: full, relDir, pkg });
						pkgDirs.push({ dir: full, relDir, pkg });
					}
				} catch {}
			}
			findPackages(full, depth + 1);
		}
	}
}

findPackages(join(ROOT, "packages"));

for (const { dir, relDir, pkg } of pkgDirs) {
	const prodDeps = pkg.dependencies ?? {};
	const wsDeps = Object.keys(prodDeps).filter(k => prodDeps[k]?.startsWith("workspace:"));

	const references = [];
	for (const dep of wsDeps) {
		const depInfo = pkgMap.get(dep);
		if (!depInfo) continue;
		const relPath = relative(dir, depInfo.dir);
		references.push({ path: relPath + "/tsconfig.build.json" });
	}

	const extendsDepth = relative(dir, ROOT);
	const extendsPath = "./" + extendsDepth + "/tsconfig.base.json";

	const extraIncludes = [];
	if (existsSync(join(dir, "src/transformers.d.ts"))) {
		extraIncludes.push("src/transformers.d.ts");
	}

	const config = {
		extends: extendsPath,
		compilerOptions: {
			composite: true,
			noEmit: false,
			outDir: "./dist",
			rootDir: "./src",
			declaration: true,
			declarationMap: true,
			sourceMap: true,
		},
		include: ["src/**/*.ts", ...extraIncludes],
		exclude: ["node_modules", "dist", "**/*.test.ts", "test/**"],
	};

	if (references.length > 0) {
		config.references = references;
	}

	writeFileSync(join(dir, "tsconfig.build.json"), JSON.stringify(config, null, "\t") + "\n");
	console.log(`${relDir}/tsconfig.build.json (${references.length} refs)`);
}

const rootConfig = {
	files: [],
	references: pkgDirs.map(({ relDir }) => ({ path: relDir + "/tsconfig.build.json" })),
};

writeFileSync(join(ROOT, "tsconfig.build.json"), JSON.stringify(rootConfig, null, "\t") + "\n");
console.log(`\ntsconfig.build.json (root, ${pkgDirs.length} packages)`);
console.log("\nBuild: tsc --build tsconfig.build.json");
