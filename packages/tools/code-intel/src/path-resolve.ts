/**
 * Path helpers for indexing and dependency resolution.
 */

import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/** Store paths relative to cwd when possible. */
export function toStoredPath(absolute: string, cwd: string): string {
	const rel = relative(cwd, absolute);
	return rel && !rel.startsWith("..") ? rel : absolute;
}

/** Resolve cwd-relative or absolute path. */
export function resolveWorkspacePath(path: string, cwd: string): string {
	return isAbsolute(path) ? path : resolve(cwd, path);
}

/** Resolve a relative/absolute import specifier to a stored workspace path. */
export function resolveImportPath(importPath: string, fromFile: string, cwd: string): string | null {
	if (!importPath.startsWith(".") && !importPath.startsWith("/")) return null;
	const base = importPath.startsWith("/")
		? resolve(cwd, importPath.slice(1))
		: resolve(dirname(fromFile), importPath);

	// TS/NodeNext: import "./foo.js" often maps to foo.ts on disk
	const withoutJsExt = base.replace(/\.(js|jsx|mjs|cjs)$/, "");
	const candidates = [
		base,
		withoutJsExt,
		`${withoutJsExt}.ts`,
		`${withoutJsExt}.tsx`,
		`${withoutJsExt}.js`,
		`${withoutJsExt}.jsx`,
		`${withoutJsExt}.mjs`,
		`${withoutJsExt}.cjs`,
		`${base}.ts`,
		`${base}.tsx`,
		`${base}.js`,
		`${base}.jsx`,
		join(withoutJsExt, "index.ts"),
		join(withoutJsExt, "index.tsx"),
		join(withoutJsExt, "index.js"),
		join(base, "index.ts"),
		join(base, "index.tsx"),
		join(base, "index.js"),
	];
	for (const candidate of candidates) {
		if (existsSync(candidate)) return toStoredPath(candidate, cwd);
	}
	return null;
}
