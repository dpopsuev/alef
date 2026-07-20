/**
 * SBOM (Software Bill of Materials) -- computed at import time.
 *
 * Hashes source files for each component to produce a fingerprint.
 * The restart policy diffs the running SBOM against a freshly computed
 * one to determine the minimum restart scope after :update.
 *
 * Same pattern as BUILD_INFO: synchronous, deterministic, always fresh.
 */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Restart scope for a component -- determines what to restart on change. */
export type RestartScope = "exit" | "tui" | "supervisor" | "adapter" | "none";

/** A single component in the SBOM. */
export interface SbomComponent {
	name: string;
	scope: RestartScope;
	hash: string;
	files: number;
}

/** The full SBOM structure. */
export interface Sbom {
	version: 1;
	generatedAt: string;
	gitHash: string;
	components: SbomComponent[];
}

// ---------------------------------------------------------------------------
// Component definitions
// ---------------------------------------------------------------------------

interface ComponentDef {
	name: string;
	scope: RestartScope;
	paths: string[];
}

const STATIC_COMPONENTS: ComponentDef[] = [
	{ name: "bootstrapper", scope: "exit", paths: ["packages/cli/src/boot"] },
	{ name: "tui", scope: "tui", paths: ["packages/ui/tui/src", "packages/cli/src/client"] },
	{
		name: "supervisor",
		scope: "supervisor",
		paths: ["packages/core/foundry/src", "packages/core/supervisor/src", "packages/core/engine/src"],
	},
	{ name: "core:kernel", scope: "exit", paths: ["packages/core/kernel/src"] },
	{ name: "core:agent", scope: "exit", paths: ["packages/core/agent/src"] },
	{ name: "core:session", scope: "exit", paths: ["packages/core/session/src"] },
	{ name: "core:ai", scope: "exit", paths: ["packages/core/ai/src"] },
	{ name: "core:storage", scope: "supervisor", paths: ["packages/core/storage/src"] },
];

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".sql"]);

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

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
		/* directory doesn't exist */
	}
	return files.sort();
}

/** Compute a stable hash of all source files in a component. */
function hashComponent(root: string, paths: string[]): { hash: string; fileCount: number } {
	const hasher = createHash("sha256");
	let fileCount = 0;
	for (const basePath of paths) {
		const absPath = join(root, basePath);
		for (const file of collectFiles(absPath)) {
			const rel = relative(root, file);
			const content = readFileSync(file);
			hasher.update(rel);
			hasher.update(content);
			fileCount++;
		}
	}
	return { hash: hasher.digest("hex").slice(0, 16), fileCount };
}

/** Discover adapter packages under packages/tools/. */
function discoverAdapters(root: string): ComponentDef[] {
	const toolsDir = join(root, "packages/tools");
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
				scope: "adapter",
				paths: [`packages/tools/${d.name}/src`],
			}));
	} catch {
		return [];
	}
}

/** Get the current git short hash. */
function readGitHash(): string {
	try {
		return execSync("git rev-parse --short HEAD", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
	} catch {
		return "unknown";
	}
}

// ---------------------------------------------------------------------------
// SBOM generation
// ---------------------------------------------------------------------------

/** Compute the SBOM for a workspace root. */
export function generateSbom(root?: string): Sbom {
	const rootDir = root ?? resolve(import.meta.dirname, "../../../..");
	const allDefs = [...STATIC_COMPONENTS, ...discoverAdapters(rootDir)];

	const components: SbomComponent[] = allDefs.map((def) => {
		const { hash, fileCount } = hashComponent(rootDir, def.paths);
		return { name: def.name, scope: def.scope, hash, files: fileCount };
	});

	return {
		version: 1,
		generatedAt: new Date().toISOString(),
		gitHash: readGitHash(),
		components,
	};
}

/** The SBOM for the current process, computed once at import time. */
export const SBOM: Sbom = generateSbom();
