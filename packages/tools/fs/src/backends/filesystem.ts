/**
 * FilesystemBackend — real Node.js filesystem implementation of BackendProtocol.
 */

import { readFile, writeFile, mkdir, unlink, readdir, stat as fsStat } from "node:fs/promises";
import { dirname } from "node:path";
import type { BackendProtocol, FileEntry, GlobMatch, GrepMatch } from "@dpopsuev/alef-kernel/backend";

/**
 * Real filesystem backend using Node.js fs APIs.
 *
 * All paths must be absolute. Throws standard Node.js ENOENT, EACCES, etc. errors.
 */
export class FilesystemBackend implements BackendProtocol {
	async read(absolutePath: string): Promise<string> {
		return await readFile(absolutePath, "utf-8");
	}

	async write(absolutePath: string, content: string): Promise<void> {
		// Create parent directories if needed
		await mkdir(dirname(absolutePath), { recursive: true });
		await writeFile(absolutePath, content, "utf-8");
	}

	async delete(absolutePath: string): Promise<void> {
		await unlink(absolutePath);
	}

	async ls(absolutePath: string): Promise<FileEntry[]> {
		const entries = await readdir(absolutePath, { withFileTypes: true });
		const results: FileEntry[] = [];

		for (const entry of entries) {
			const fullPath = `${absolutePath}/${entry.name}`;
			const stats = await fsStat(fullPath);
			
			let type: "file" | "directory" | "symlink" = "file";
			if (entry.isDirectory()) type = "directory";
			else if (entry.isSymbolicLink()) type = "symlink";

			results.push({
				path: fullPath,
				type,
				size: stats.size,
				mtime: stats.mtimeMs,
			});
		}

		return results;
	}

	glob(
		_pattern: string,
		_rootPath: string,
		_options?: { maxDepth?: number; includeHidden?: boolean },
	): Promise<GlobMatch[]> {
		// For now, this is a placeholder - full implementation would use a glob library
		// or delegate to the existing fd-based find-query implementation
		return Promise.reject(new Error("FilesystemBackend.glob: not yet implemented (use find-query)"));
	}

	grep(
		_pattern: string,
		_rootPath: string,
		_options?: { ignoreCase?: boolean; literal?: boolean; maxMatches?: number },
	): Promise<GrepMatch[]> {
		// For now, this is a placeholder - full implementation would use ripgrep
		// or delegate to the existing grep-query implementation
		return Promise.reject(new Error("FilesystemBackend.grep: not yet implemented (use grep-query)"));
	}

	async stat(absolutePath: string): Promise<FileEntry> {
		const stats = await fsStat(absolutePath);
		
		let type: "file" | "directory" | "symlink" = "file";
		if (stats.isDirectory()) type = "directory";
		else if (stats.isSymbolicLink()) type = "symlink";

		return {
			path: absolutePath,
			type,
			size: stats.size,
			mtime: stats.mtimeMs,
		};
	}

	async exists(absolutePath: string): Promise<boolean> {
		try {
			await fsStat(absolutePath);
			return true;
		} catch {
			return false;
		}
	}
}
