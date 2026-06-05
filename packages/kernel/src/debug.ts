/**
 * debugLog — shared structured log writer for all Alef packages.
 *
 * When a pino logger has been registered via initSpineLogger(), emits at
 * debug level through it. Otherwise falls back to appending a JSON line to
 * ~/.alef/debug.log when ALEF_DEBUG=1.
 *
 * Call initSpineLogger(rootLogger.child({ component: "spine" })) from the
 * runner entry point to unify all debug output under the pino pipeline.
 *
 * Usage:
 *   import { debugLog } from "@dpopsuev/alef-kernel";
 *   debugLog("llm:http:start", { turn, messages: n, tools: n });
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOG_DIR = join(homedir(), ".alef");
const LOG_PATH = join(LOG_DIR, "debug.log");

interface MinimalLogger {
	debug(obj: Record<string, unknown>, msg: string): void;
}

let sharedLogger: MinimalLogger | undefined;

/** Register a pino logger to receive all debugLog calls. Called once at runner startup. */
export function initSpineLogger(logger: MinimalLogger): void {
	sharedLogger = logger;
}

export function debugLog(event: string, extra?: Record<string, unknown>): void {
	if (sharedLogger) {
		sharedLogger.debug(extra ?? {}, event);
		return;
	}
	if (process.env.ALEF_DEBUG !== "1") return;
	const line = `${JSON.stringify({ t: new Date().toISOString(), event, ...extra })}\n`;
	try {
		mkdirSync(LOG_DIR, { recursive: true });
		appendFileSync(LOG_PATH, line, "utf-8");
	} catch {
		// never crash if logging fails
	}
}
