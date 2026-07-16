import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * ToolResultOffloader: Automatically offloads large tool results to filesystem.
 * Threshold for offloading tool results to filesystem. Default 2000 chars.
 */
const OFFLOAD_THRESHOLD = Number.parseInt(process.env.ALEF_OFFLOAD_THRESHOLD ?? "2000", 10);

/** Default offload root directory. */
function xdgDataHome(): string {
	return process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
}

/** Get offload directory for a session. */
export function getOffloadDir(sessionId: string): string {
	return join(xdgDataHome(), "alef", "tool-results", sessionId);
}

/** Offload result structure returned when content is offloaded. */
export interface OffloadedResult {
	offloaded: true;
	path: string;
	originalSize: number;
	threshold: number;
}

/** Result from offload check - either original content or offload reference. */
export type OffloadCheckResult =
	| { offloaded: false; content: string }
	| OffloadedResult;

/**
 * Check if content should be offloaded based on size threshold.
 * If yes, write to filesystem and return reference. If no, return original content.
 */
export async function checkAndOffloadContent(
	content: string,
	sessionId: string,
	toolCallId: string,
): Promise<OffloadCheckResult> {
	if (content.length <= OFFLOAD_THRESHOLD) {
		return { offloaded: false, content };
	}

	// Create offload directory
	const offloadDir = getOffloadDir(sessionId);
	await mkdir(offloadDir, { recursive: true });

	// Write content to file
	const filename = `${toolCallId}.txt`;
	const filepath = join(offloadDir, filename);
	await writeFile(filepath, content, "utf-8");

	return {
		offloaded: true,
		path: filepath,
		originalSize: content.length,
		threshold: OFFLOAD_THRESHOLD,
	};
}

/**
 * Format offloaded result reference for display to LLM.
 */
export function formatOffloadedReference(result: OffloadedResult): string {
	return `[Large result offloaded to ${result.path}. Use fs.read to retrieve. Original size: ${result.originalSize} chars, threshold: ${result.threshold}]`;
}

/**
 * Clean up tool results for a session.
 */
export async function cleanupToolResults(sessionId: string): Promise<void> {
	const { rm } = await import("node:fs/promises");
	const offloadDir = getOffloadDir(sessionId);
	try {
		await rm(offloadDir, { recursive: true, force: true });
	} catch {
		// Ignore errors - directory may not exist
	}
}
