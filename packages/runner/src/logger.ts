/**
 * Logger — pino instance factory for the Alef runner.
 *
 * Writes structured JSONL to stderr (never stdout — stdout carries agent replies).
 *
 * ROGYB compliance:
 *   Orange (warn)  — organ failures, validation errors, context window truncation
 *   Yellow (debug) — cache hits, invalidations, tool dispatches
 *   Green          — production default (level=warn, only failures visible)
 *   Blue           — ALEF_LOG_LEVEL=debug for deep inspection
 *
 * Usage:
 *   const log = createLogger()
 *   createFsOrgan({ cwd, logger: log.child({ organ: 'fs' }) })
 */

import type { Logger } from "pino";
import pino from "pino";
import { debugLogPath } from "./debug-trace.js";

export type { Logger };

/**
 * Create the runner logger for the current invocation mode.
 * Chooses between stderr (non-TUI) and file (TUI) transports internally.
 */
export function createRunnerLogger(willUseTui: boolean, debug: boolean): Logger {
	const level = debug ? "debug" : undefined;
	return willUseTui && (debug || process.env.ALEF_LOG_LEVEL === "debug")
		? createLoggerForTui(debugLogPath(), level)
		: createLogger(level);
}

export function createLogger(level?: string): Logger {
	return pino({
		level: level ?? process.env.ALEF_LOG_LEVEL ?? "warn",
		transport: process.stderr.isTTY ? { target: "pino/file", options: { destination: 2 } } : undefined,
		...(process.stderr.isTTY ? {} : { destination: 2 }),
		base: { pid: process.pid },
		timestamp: pino.stdTimeFunctions.isoTime,
	});
}

/**
 * Logger for TUI mode: writes to a file instead of stderr.
 * Prevents structured log lines from leaking into the TUI viewport,
 * which shares the PTY with stderr in terminal emulators.
 */
export function createLoggerForTui(logPath: string, level?: string): Logger {
	return pino({
		level: level ?? process.env.ALEF_LOG_LEVEL ?? "warn",
		transport: {
			target: "pino/file",
			options: { destination: logPath, append: true },
		},
		base: { pid: process.pid },
		timestamp: pino.stdTimeFunctions.isoTime,
	});
}
