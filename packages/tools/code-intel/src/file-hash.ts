/**
 * File hashing utilities for incremental change detection.
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

/**
 * File metadata for change detection.
 */
export interface FileMetadata {
	hash: string;
	mtime: number;
	size: number;
}

/**
 * Compute SHA-256 hash of file content.
 */
export function computeFileHash(filePath: string): string {
	const content = readFileSync(filePath, "utf-8");
	return createHash("sha256").update(content).digest("hex");
}

/**
 * Get file metadata for change detection.
 */
export function getFileMetadata(filePath: string): FileMetadata {
	const stats = statSync(filePath);
	const hash = computeFileHash(filePath);
	
	return {
		hash,
		mtime: Math.floor(stats.mtimeMs),
		size: stats.size,
	};
}
