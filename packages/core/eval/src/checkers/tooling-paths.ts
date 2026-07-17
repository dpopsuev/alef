import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Resolve the monorepo root for checker helper tooling. */
function resolveMonorepoRoot(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	const candidates = [join(here, "../../../../../"), join(here, "../../../../"), process.cwd()];
	for (const candidate of candidates) {
		if (existsSync(join(candidate, "node_modules")) && existsSync(join(candidate, "tsconfig.json"))) {
			return candidate;
		}
	}
	return candidates[0]!;
}

const MONOREPO_ROOT = resolveMonorepoRoot();
const MONOREPO_PATHS = loadMonorepoPaths();

/** Load tsconfig path aliases from the monorepo root. */
function loadMonorepoPaths(): Record<string, string[]> {
	const tsconfigPath = monorepoPath("tsconfig.json");
	const raw = readFileSync(tsconfigPath, "utf-8");
	const parsed: unknown = JSON.parse(raw);
	if (!parsed || typeof parsed !== "object") return {};
	const compilerOptions = "compilerOptions" in parsed ? parsed.compilerOptions : undefined;
	if (!compilerOptions || typeof compilerOptions !== "object") return {};
	const paths = "paths" in compilerOptions ? compilerOptions.paths : undefined;
	if (!paths || typeof paths !== "object") return {};

	const resolvedPaths: Record<string, string[]> = {};
	for (const [key, value] of Object.entries(paths)) {
		if (typeof key !== "string" || !Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
			continue;
		}
		resolvedPaths[key] = value;
	}
	return resolvedPaths;
}

/** Build an absolute path rooted at the monorepo root. */
export function monorepoPath(...parts: string[]): string {
	return join(MONOREPO_ROOT, ...parts);
}

/** Return the repo root `node_modules` directory. */
export function monorepoNodeModulesPath(): string {
	return monorepoPath("node_modules");
}

/** Build the temp-workspace tsconfig used by eval compile and test checkers. */
export function buildEvalTsconfig(): string {
	return JSON.stringify({
		compilerOptions: {
			strict: true,
			noEmit: true,
			target: "ESNext",
			module: "NodeNext",
			moduleResolution: "NodeNext",
			skipLibCheck: true,
			allowSyntheticDefaultImports: true,
			types: ["node"],
			baseUrl: MONOREPO_ROOT,
			paths: MONOREPO_PATHS,
		},
		include: ["**/*.ts"],
		exclude: ["node_modules", "vitest.config.ts"],
	});
}

/** Build the temp-workspace Vitest config used by eval test checkers. */
export function buildEvalVitestConfig(): string {
	return [
		'import { defineConfig } from "vitest/config";',
		"",
		"export default defineConfig({",
		"\tresolve: {",
		"\t\ttsconfigPaths: true,",
		"\t},",
		"});",
		"",
	].join("\n");
}
