/**
 * debugLog — shared structured log writer for all Alef packages.
 *
 * Writes a JSON line to ~/.alef/debug.log when ALEF_DEBUG=1.
 * No-op otherwise. Never throws — logging must never crash the agent.
 *
 * Format matches debug-trace.ts so all events are readable together:
 *   { "t": "<ISO>", "event": "<name>", ...extra }
 *
 * Usage:
 *   import { debugLog } from "@dpopsuev/alef-spine";
 *   debugLog("llm:http:start", { turn, messages: n, tools: n });
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOG_DIR = join(homedir(), ".alef");
const LOG_PATH = join(LOG_DIR, "debug.log");

export function debugLog(event: string, extra?: Record<string, unknown>): void {
	if (process.env.ALEF_DEBUG !== "1") return;
	const line = `${JSON.stringify({ t: new Date().toISOString(), event, ...extra })}\n`;
	try {
		mkdirSync(LOG_DIR, { recursive: true });
		appendFileSync(LOG_PATH, line, "utf-8");
	} catch {
		// never crash if logging fails
	}
}
