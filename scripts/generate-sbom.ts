#!/usr/bin/env tsx
/**
 * Generate a Software Bill of Materials (SBOM) with per-component content hashes.
 *
 * Each component maps to a restart scope:
 *   - bootstrapper: full process exit
 *   - tui: TUI restart (teardown + rebuild)
 *   - supervisor: drain active work + service restart
 *   - adapter:<name>: hot-reload single adapter
 *   - core: full process exit (kernel, agent, session, ai changes)
 *
 * The SBOM is a JSON file consumed at runtime by the restart policy.
 * On :update, the old SBOM is diffed against the new one to determine
 * the minimum restart scope.
 *
 * Usage:
 *   npx tsx scripts/generate-sbom.ts
 *   npx tsx scripts/generate-sbom.ts --output path/to/sbom.json
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RestartScope = "exit" | "tui" | "supervisor" | "adapter" | "none";

interface SbomComponent {
	name: string;
	scope: RestartScope;
	hash: string;
	files: number;
}

interface Sbom {
	version: 1;
	generatedAt: string;
	gitHash: string;
	components: SbomComponent[];
}

// ---------------------------------------------------------------------------
// Component definitions -- which packages map to which restart scope
// ---------------------------------------------------------------------------

interface ComponentDef {
	name: string;
	scope: RestartScope;
	paths: string[];
}

const COMPONENTS: ComponentDef[] = [
	{
		name: "bootstrapper",
		scope: "exit",
		paths: ["packages/cli/src/boot"],
	},
	{
		name: "tui",
		scope: "tui",
		paths: ["packages/ui/tui/src", "packages/cli/src/client"],
	},
	{
		name: "supervisor",
		scope: "supervisor",
		paths: ["packages/core/foundry/src", "packages/core/supervisor/src", "packages/core/engine/src"],
	},
	{
		name: "core:kernel",
		scope: "exit",
		paths: ["packages/core/kernel/src"],
	},
	{
		name: "core:agent",
		scope: "exit",
		paths: ["packages/core/agent/src"],
	},
	{
		name: "core:session",
		scope: "exit",
		paths: ["packages/core/session/src"],
	},
	{
		name: "core:ai",
		scope: "exit",
		paths: ["packages/core/ai/src"],
	},
	{
		name: "core:storage",
		scope: "supervisor",
		paths: ["packages/core/storage/src"],
	},
];

/** Dynamically discover adapter packages under packages/tools/. */
function discoverAdapters(): ComponentDef[] {
	const toolsDir = join(ROOT, "packages/tools");
	try {
		return readdirSync(toolsDir, { withFileTypes: true })
			.filter((d) => d.isDirectory())
			.filter((d) => {
				try {
					statSync(join(toolsDir, d.name, "src"));
					return true;
				} catch {
					return false;
				}
			})
			.map((d) => ({
				name: `adapter:${d.name}`,
				scope: "adapter" as RestartScope,
				paths: [`packages/tools/${d.name}/src`],
			}));
	} catch {
		return [];
	}
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".sql"]);

/** Recursively collect source file paths under a directory. */
function collectFiles(dir: string): string[] {
	const files: string[] = [];
	try {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "test") continue;
				files.push(...collectFiles(full));
			} else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) {
				files.push(full);
			}
		}
	} catch {
		// directory doesn't exist
	}
	return files.sort();
}

/** Compute a stable hash of all source files in a component. */
function hashComponent(paths: string[]): { hash: string; fileCount: number } {
	const hasher = createHash("sha256");
	let fileCount = 0;
	for (const basePath of paths) {
		const absPath = join(ROOT, basePath);
		for (const file of collectFiles(absPath)) {
			const rel = relative(ROOT, file);
			const content = readFileSync(file);
			hasher.update(rel);
			hasher.update(content);
			fileCount++;
		}
	}
	return { hash: hasher.digest("hex").slice(0, 16), fileCount };
}

/** Get the current git hash. */
function gitHash(): string {
	try {
		const { execSync } = require("node:child_process");
		return execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
	} catch {
		return "unknown";
	}
}

import { extname } from "node:path";

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function generate(): Sbom {
	const allComponents = [...COMPONENTS, ...discoverAdapters()];

	const components: SbomComponent[] = allComponents.map((def) => {
		const { hash, fileCount } = hashComponent(def.paths);
		return {
			name: def.name,
			scope: def.scope,
			hash,
			files: fileCount,
		};
	});

	return {
		version: 1,
		generatedAt: new Date().toISOString(),
		gitHash: gitHash(),
		components,
	};
}

const outputArg = process.argv.indexOf("--output");
const outputPath = outputArg >= 0 ? process.argv[outputArg + 1] : join(ROOT, "sbom.json");

const sbom = generate();
writeFileSync(outputPath!, JSON.stringify(sbom, null, 2) + "\n");

const totalFiles = sbom.components.reduce((sum, c) => sum + c.files, 0);
console.log(`SBOM: ${sbom.components.length} components, ${totalFiles} files`);
for (const c of sbom.components) {
	console.log(`  ${c.name.padEnd(24)} ${c.scope.padEnd(12)} ${c.hash}  (${c.files} files)`);
}
