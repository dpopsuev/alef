/**
 * MemoryBackend — ephemeral in-memory implementation of BackendProtocol.
 *
 * Useful for testing and sandboxed execution where filesystem access should
 * not touch the real disk.
 */

import { minimatch } from "minimatch";
import type { BackendProtocol, FileEntry, GlobMatch, GrepMatch } from "@dpopsuev/alef-kernel/backend";

interface MemoryFile {
	content: string;
	mtime: number;
}

interface MemoryDirectory {
	mtime: number;
}

type MemoryEntry = MemoryFile | MemoryDirectory;

/**
 *
 */
function isFile(entry: MemoryEntry): entry is MemoryFile {
	return "content" in entry;
}

/** Wrap synchronous backend logic in Promise semantics. */
function syncPromise<T>(operation: () => T): Promise<T> {
	try {
		return Promise.resolve(operation());
	} catch (error) {
		return Promise.reject(error instanceof Error ? error : new Error(String(error)));
	}
}

/**
 * In-memory filesystem backend.
 *
 * All paths must be absolute (start with /). Data is stored in a Map and
 * persists only for the lifetime of the MemoryBackend instance.
 */
export class MemoryBackend implements BackendProtocol {
	private readonly files = new Map<string, MemoryEntry>();

	constructor() {
		// Always create root directory
		this.files.set("/", { mtime: Date.now() });
	}

	read(absolutePath: string): Promise<string> {
		return syncPromise(() => {
			const entry = this.files.get(absolutePath);
			if (!entry) {
				throw new Error(`ENOENT: no such file or directory: ${absolutePath}`);
			}
			if (!isFile(entry)) {
				throw new Error(`EISDIR: illegal operation on a directory: ${absolutePath}`);
			}
			return entry.content;
		});
	}

	write(absolutePath: string, content: string): Promise<void> {
		return syncPromise(() => {
			// Ensure parent directories exist
			this.ensureParentDirs(absolutePath);

			this.files.set(absolutePath, {
				content,
				mtime: Date.now(),
			});
		});
	}

	delete(absolutePath: string): Promise<void> {
		return syncPromise(() => {
			if (!this.files.has(absolutePath)) {
				throw new Error(`ENOENT: no such file or directory: ${absolutePath}`);
			}
			this.files.delete(absolutePath);
		});
	}

	ls(absolutePath: string): Promise<FileEntry[]> {
		return syncPromise(() => {
			const entry = this.files.get(absolutePath);
			if (!entry) {
				throw new Error(`ENOENT: no such file or directory: ${absolutePath}`);
			}
			if (isFile(entry)) {
				throw new Error(`ENOTDIR: not a directory: ${absolutePath}`);
			}

			const results: FileEntry[] = [];
			const prefix = absolutePath === "/" ? "/" : `${absolutePath}/`;

			for (const [path, e] of this.files.entries()) {
				if (path === absolutePath) continue;
				if (!path.startsWith(prefix)) continue;

				// Only immediate children (no nested slashes after prefix)
				const relative = path.slice(prefix.length);
				if (relative.includes("/")) continue;

				results.push({
					path,
					type: isFile(e) ? "file" : "directory",
					size: isFile(e) ? e.content.length : 0,
					mtime: e.mtime,
				});
			}

			return results;
		});
	}

	glob(
		pattern: string,
		rootPath: string,
		options?: { maxDepth?: number; includeHidden?: boolean },
	): Promise<GlobMatch[]> {
		return syncPromise(() => {
			const results: GlobMatch[] = [];
			const includeHidden = options?.includeHidden ?? true;
			const maxDepth = options?.maxDepth;

			for (const [path, entry] of this.files.entries()) {
				if (!path.startsWith(rootPath)) continue;

				// Check depth
				if (maxDepth !== undefined) {
					const relative = path.slice(rootPath.length);
					const depth = relative.split("/").filter((s) => s.length > 0).length;
					if (depth > maxDepth) continue;
				}

				// Check hidden files
				if (!includeHidden) {
					const parts = path.split("/");
					const hasHidden = parts.some((p) => p.startsWith(".") && p.length > 1);
					if (hasHidden) continue;
				}

				// Check pattern match
				if (minimatch(path, pattern, { dot: true })) {
					results.push({
						path,
						isDirectory: !isFile(entry),
					});
				}
			}

			return results;
		});
	}

	grep(
		pattern: string,
		rootPath: string,
		options?: { ignoreCase?: boolean; literal?: boolean; maxMatches?: number },
	): Promise<GrepMatch[]> {
		return syncPromise(() => {
			const results: GrepMatch[] = [];
			const ignoreCase = options?.ignoreCase ?? false;
			const literal = options?.literal ?? false;
			const maxMatches = options?.maxMatches ?? 1000;

			// Build regex
			let regex: RegExp;
			if (literal) {
				const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
				regex = new RegExp(escaped, ignoreCase ? "gi" : "g");
			} else {
				regex = new RegExp(pattern, ignoreCase ? "gi" : "g");
			}

			for (const [path, entry] of this.files.entries()) {
				if (!path.startsWith(rootPath)) continue;
				if (!isFile(entry)) continue;

				const lines = entry.content.split("\n");
				for (let i = 0; i < lines.length; i++) {
					const line = lines[i]!;
					if (regex.test(line)) {
						results.push({
							path,
							line: i + 1,
							content: line,
						});

						if (results.length >= maxMatches) {
							return results;
						}
					}
					// Reset regex lastIndex for global regex
					regex.lastIndex = 0;
				}
			}

			return results;
		});
	}

	stat(absolutePath: string): Promise<FileEntry> {
		return syncPromise(() => {
			const entry = this.files.get(absolutePath);
			if (!entry) {
				throw new Error(`ENOENT: no such file or directory: ${absolutePath}`);
			}

			return {
				path: absolutePath,
				type: isFile(entry) ? "file" : "directory",
				size: isFile(entry) ? entry.content.length : 0,
				mtime: entry.mtime,
			};
		});
	}

	exists(absolutePath: string): Promise<boolean> {
		return Promise.resolve(this.files.has(absolutePath));
	}

	/**
	 * Ensure all parent directories exist for a given path.
	 * Creates intermediate directories as needed.
	 */
	private ensureParentDirs(absolutePath: string): void {
		const parts = absolutePath.split("/").filter((p) => p.length > 0);
		let current = "";

		for (let i = 0; i < parts.length - 1; i++) {
			current += `/${parts[i]}`;
			if (!this.files.has(current)) {
				this.files.set(current, { mtime: Date.now() });
			}
		}
	}

	/**
	 * Get a snapshot of all files for debugging/testing.
	 */
	snapshot(): Map<string, string> {
		const result = new Map<string, string>();
		for (const [path, entry] of this.files.entries()) {
			if (isFile(entry)) {
				result.set(path, entry.content);
			}
		}
		return result;
	}
}
