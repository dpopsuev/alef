/**
 * Debug lifecycle trace — writes timestamped events to ~/.alef/debug.log.
 *
 * Bypasses pino and the TUI entirely: uses synchronous appendFileSync so
 * events are flushed even if the process hangs immediately after.
 *
 * Enabled by --debug flag or ALEF_DEBUG=1. The log path is always the same
 * file (overwritten on each run) so `tail -f ~/.alef/debug.log` works.
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOG_PATH = join(homedir(), ".alef", "debug.log");
let enabled = false;

export function initDebugTrace(on: boolean): void {
	enabled = on || process.env.ALEF_DEBUG === "1";
	// Always ensure the log file exists — ALWAYS_TRACE events write to it regardless of --debug.
	mkdirSync(join(homedir(), ".alef"), { recursive: true });
	writeFileSync(LOG_PATH, `--- alef debug trace ${new Date().toISOString()} ---\n`, "utf-8");
	trace("init");
}

/** Events that are always written regardless of --debug flag. Each fires ≤ once per tool call or turn. */
const ALWAYS_TRACE = new Set(["receiveTextChunk:first", "sealStreamingSegment", "tool:start", "tool:end"]);

export function trace(event: string, extra?: Record<string, unknown>): void {
	if (!enabled && !ALWAYS_TRACE.has(event)) return;
	const line = `${JSON.stringify({ t: new Date().toISOString(), event, ...extra })}\n`;
	try {
		appendFileSync(LOG_PATH, line, "utf-8");
	} catch {
		// If the log itself fails, don't crash the process.
	}
}

export function debugLogPath(): string {
	return LOG_PATH;
}
