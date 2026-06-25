#!/usr/bin/env node
/**
 * Generate tsconfig.build.json with composite + references for all workspace packages.
 * Also generates root tsconfig.build.json with references to all packages.
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, relative, dirname } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

// Map package name → directory
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
					if (pkg.name && !pkg.private) {
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

// For each package, generate tsconfig.build.json
for (const { dir, relDir, pkg } of pkgDirs) {
	const deps = pkg.dependencies ?? {};
	const wsDeps = Object.keys(deps).filter(k => deps[k]?.startsWith("workspace:"));

	// Build references to workspace deps that have tsconfig.build.json
	const references = [];
	for (const dep of wsDeps) {
		const depInfo = pkgMap.get(dep);
		if (!depInfo) continue;
		const depBuildConfig = join(depInfo.dir, "tsconfig.build.json");
		// Only reference packages that will have build configs
		const relPath = relative(dir, depInfo.dir);
		references.push({ path: relPath + "/tsconfig.build.json" });
	}

	const extendsPath = relative(dir, ROOT) + "/tsconfig.base.json";

	// Check for special files to include (like .d.ts stubs)
	const extraIncludes = [];
	if (existsSync(join(dir, "src/transformers.d.ts"))) {
		extraIncludes.push("src/transformers.d.ts");
	}

	const config = {
		extends: `./${extendsPath}`,
		compilerOptions: {
			composite: true,
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

	writeFileSync(
		join(dir, "tsconfig.build.json"),
		JSON.stringify(config, null, "\t") + "\n",
	);
	console.log(`wrote: ${relDir}/tsconfig.build.json (${references.length} refs)`);
}

// Generate root tsconfig.build.json
const rootConfig = {
	files: [],
	references: pkgDirs.map(({ relDir }) => ({ path: relDir + "/tsconfig.build.json" })),
};

writeFileSync(
	join(ROOT, "tsconfig.build.json"),
	JSON.stringify(rootConfig, null, "\t") + "\n",
);
console.log(`\nwrote: tsconfig.build.json (root, ${pkgDirs.length} packages)`);
console.log("Build with: tsc --build tsconfig.build.json");
