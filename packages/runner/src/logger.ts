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

export type { Logger };

export function createLogger(level?: string): Logger {
	return pino({
		level: level ?? process.env.ALEF_LOG_LEVEL ?? "warn",
		// Write to stderr — agent reply goes to stdout.
		transport: process.stderr.isTTY
			? {
					// Pretty-print in dev TTY sessions.
					target: "pino/file",
					options: { destination: 2 }, // fd 2 = stderr
				}
			: undefined,
		// stderr destination for non-TTY (pipes, CI).
		...(process.stderr.isTTY ? {} : { destination: 2 }),
		base: { pid: process.pid },
		timestamp: pino.stdTimeFunctions.isoTime,
	});
}
