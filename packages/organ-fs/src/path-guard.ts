/**
 * pathGuard — enforce that a resolved path stays within allowed roots.
 *
 * Called by every FsOrgan handler before any disk I/O. Throws if the
 * resolved absolute path is not within any of the allowed roots (after
 * resolving via the path string — we do not call realpath to avoid TOCTOU
 * and to keep the guard sync-safe).
 *
 * Traversal attack vectors blocked:
 *   ../../etc/passwd          — relative traversal
 *   /etc/passwd               — absolute path outside roots
 *   /workspace/../etc/passwd  — normalised absolute traversal
 *
 * OCAP model: the guard enforces capabilities that were injected at
 * construction time. Organs only access what the materializer granted.
 */

import { resolve } from "node:path";

export interface PathGuardOptions {
	/** Primary workspace root. Paths are resolved relative to this. */
	root: string;
	/** All writable/readable roots. A path is allowed if it falls within any of these. */
	writableRoots?: readonly string[];
}

function isWithin(normAbs: string, normRoot: string): boolean {
	return normAbs === normRoot || normAbs.startsWith(`${normRoot}/`);
}

/**
 * Assert that `abs` is within at least one of the allowed roots.
 * Throws a descriptive error on violation.
 * `abs` must already be resolved to an absolute path.
 */
export function assertWithinRoots(abs: string, roots: readonly string[]): void {
	const normAbs = resolve(abs);

	for (const root of roots) {
		if (isWithin(normAbs, resolve(root))) return;
	}

	const rootList = roots.map((r) => `'${resolve(r)}'`).join(", ");
	throw new Error(
		`Path '${abs}' is outside the allowed roots [${rootList}]. ` +
			"The security profile controls which directories are accessible.",
	);
}

/**
 * Resolve `inputPath` against `root` and enforce it stays within the allowed roots.
 * Returns the absolute resolved path.
 */
export function guardedResolve(inputPath: string, opts: PathGuardOptions): string {
	const abs = resolve(opts.root, inputPath);
	const roots = opts.writableRoots ?? [opts.root];
	assertWithinRoots(abs, roots);
	return abs;
}
