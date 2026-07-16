/**
 * Backend abstraction protocol for filesystem operations.
 *
 * Enables pluggable storage backends: real filesystem, in-memory, remote, etc.
 * All methods operate on absolute paths and throw on errors.
 */

/**
 * File entry metadata returned by ls and stat operations.
 */
export interface FileEntry {
	/** Absolute path to the file. */
	path: string;
	/** Entry type. */
	type: "file" | "directory" | "symlink";
	/** File size in bytes (0 for directories). */
	size: number;
	/** Last modification time (Unix timestamp ms). */
	mtime: number;
}

/**
 * Glob match result from the glob operation.
 */
export interface GlobMatch {
	/** Absolute path to the matched file. */
	path: string;
	/** Whether this is a directory. */
	isDirectory: boolean;
}

/**
 * Grep match result from the grep operation.
 */
export interface GrepMatch {
	/** Absolute path to the file containing the match. */
	path: string;
	/** Line number (1-indexed). */
	line: number;
	/** The matched line content. */
	content: string;
}

/**
 * Abstract backend protocol for filesystem operations.
 *
 * Implementations must handle absolute paths and throw descriptive errors.
 * All operations are async to support remote backends.
 */
export interface BackendProtocol {
	/**
	 * Read file content as a UTF-8 string.
	 * @throws if file doesn't exist or is not readable
	 */
	read(absolutePath: string): Promise<string>;

	/**
	 * Write file content atomically, creating parent directories as needed.
	 * @throws if write fails or path is not writable
	 */
	write(absolutePath: string, content: string): Promise<void>;

	/**
	 * Delete a file or empty directory.
	 * @throws if path doesn't exist or deletion fails
	 */
	delete(absolutePath: string): Promise<void>;

	/**
	 * List directory contents (non-recursive).
	 * @returns Array of file entries in the directory
	 * @throws if path is not a directory or not readable
	 */
	ls(absolutePath: string): Promise<FileEntry[]>;

	/**
	 * Find files matching a glob pattern (recursive).
	 * @param pattern - Glob pattern (e.g., "**\/*.ts")
	 * @param rootPath - Root directory to search from
	 * @param options - Optional max depth and hidden file handling
	 * @returns Array of matching paths
	 */
	glob(
		pattern: string,
		rootPath: string,
		options?: { maxDepth?: number; includeHidden?: boolean },
	): Promise<GlobMatch[]>;

	/**
	 * Search file contents using a pattern (regex or literal).
	 * @param pattern - Search pattern
	 * @param rootPath - Root directory to search
	 * @param options - Search options (case-insensitive, literal, etc.)
	 * @returns Array of matching lines with file paths and line numbers
	 */
	grep(
		pattern: string,
		rootPath: string,
		options?: {
			ignoreCase?: boolean;
			literal?: boolean;
			maxMatches?: number;
		},
	): Promise<GrepMatch[]>;

	/**
	 * Get file/directory metadata.
	 * @throws if path doesn't exist
	 */
	stat(absolutePath: string): Promise<FileEntry>;

	/**
	 * Check if a path exists.
	 */
	exists(absolutePath: string): Promise<boolean>;
}
