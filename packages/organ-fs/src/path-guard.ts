/**
 * pathGuard — enforce that a resolved path stays within the allowed root.
 *
 * Called by every FsOrgan handler before any disk I/O. Throws if the
 * resolved absolute path is not within `root` (after resolving symlinks
 * via the path string — we do not call realpath to avoid TOCTOU and to
 * keep the guard sync-safe).
 *
 * Traversal attack vectors blocked:
 *   ../../etc/passwd          — relative traversal
 *   /etc/passwd               — absolute path outside root
 *   /workspace/../etc/passwd  — normalised absolute traversal
 *
 * Option `allowAbsolutePaths` bypasses the guard. Intended for power-user
 * contexts (e.g. a system-level agent that explicitly opts in). Default: off.
 */

import { resolve } from "node:path";

export interface PathGuardOptions {
	/** Workspace root. Resolved paths must be within this directory. */
	root: string;
	/** When true, absolute paths outside root are allowed. Default: false. */
	allowAbsolutePaths?: boolean;
}

/**
 * Assert that `abs` is within `root`. Throws a descriptive error on violation.
 * `abs` must already be resolved to an absolute path.
 */
export function assertWithinRoot(abs: string, root: string): void {
	// Normalise both via resolve() so trailing slashes and . segments vanish.
	const normRoot = resolve(root);
	const normAbs = resolve(abs);

	// A path is within root if it equals root or starts with root + separator.
	if (normAbs !== normRoot && !normAbs.startsWith(`${normRoot}/`)) {
		throw new Error(
			`Path '${abs}' is outside the workspace root '${normRoot}'. ` +
				"Use an absolute path within the workspace or configure allowAbsolutePaths.",
		);
	}
}

/**
 * Resolve `inputPath` against `root` and enforce it stays within `root`.
 * Returns the absolute resolved path.
 */
export function guardedResolve(inputPath: string, opts: PathGuardOptions): string {
	const abs = resolve(opts.root, inputPath);
	if (!opts.allowAbsolutePaths) {
		assertWithinRoot(abs, opts.root);
	}
	return abs;
}
