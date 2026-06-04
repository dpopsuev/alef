/**
 * Debug lifecycle trace — routes events through the pino logger once one is
 * registered via initTraceLogger(). Falls back to synchronous appendFileSync
 * before the logger is available (very early boot, crash paths).
 *
 * ALWAYS_TRACE events fire at info level regardless of --debug.
 * Everything else fires at debug level and requires --debug / ALEF_DEBUG=1.
 *
 * Call initTraceLogger(log) immediately after createRunnerLogger() to unify
 * all trace output under the pino pipeline.
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOG_DIR = join(homedir(), ".alef");
const LOG_PATH = join(LOG_DIR, "debug.log");

interface MinimalLogger {
	info(obj: Record<string, unknown>, msg: string): void;
	debug(obj: Record<string, unknown>, msg: string): void;
}

let pinoLog: MinimalLogger | undefined;

/** Register the pino logger to receive all trace() calls. Call once at startup. */
export function initTraceLogger(logger: MinimalLogger): void {
	pinoLog = logger;
}

export function debugLogPath(): string {
	return LOG_PATH;
}

/** Events that fire at info level regardless of --debug. */
const ALWAYS_INFO = new Set(["tool:start", "tool:end", "loop:detected", "boot", "tui:start", "tui:stopped"]);

let debugEnabled = false;

export function setupTrace(debug: boolean): typeof trace {
	debugEnabled = debug || process.env.ALEF_DEBUG === "1";
	mkdirSync(LOG_DIR, { recursive: true });
	// Truncate file at startup so tail -f always shows the current session.
	writeFileSync(LOG_PATH, `--- alef trace ${new Date().toISOString()} ---\n`, "utf-8");
	if (debug) process.stderr.write(`[alef] debug log: ${LOG_PATH}\n`);
	return trace;
}

export function trace(event: string, extra?: Record<string, unknown>): void {
	const isInfo = ALWAYS_INFO.has(event);
	if (!isInfo && !debugEnabled) return;

	if (pinoLog) {
		if (isInfo) {
			pinoLog.info(extra ?? {}, event);
		} else {
			pinoLog.debug(extra ?? {}, event);
		}
		return;
	}

	// Pre-logger fallback — synchronous write so events are captured even before pino is ready.
	const line = `${JSON.stringify({ t: new Date().toISOString(), event, ...extra })}\n`;
	try {
		appendFileSync(LOG_PATH, line, "utf-8");
	} catch {}
}
