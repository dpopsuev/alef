import { initSpineLogger } from "@dpopsuev/alef-kernel";
import type { Logger } from "pino";
import pino from "pino";
import { debugLogPath, initTraceLogger } from "./debug-trace.js";

export type { Logger };

/**
 * Resolve the effective log level.
 * ALEF_DEBUG=1 is a backward-compat alias for ALEF_LOG_LEVEL=debug.
 * --debug flag takes precedence over both.
 */
function resolveLevel(debug: boolean): string {
	if (debug) return "debug";
	if (process.env.ALEF_DEBUG === "1") return "debug";
	return process.env.ALEF_LOG_LEVEL ?? "warn";
}

export function createRunnerLogger(willUseTui: boolean, debug: boolean): Logger {
	const level = resolveLevel(debug);
	const logger =
		willUseTui && (level === "debug" || process.env.ALEF_LOG_LEVEL === "debug")
			? createLoggerForTui(debugLogPath(), level)
			: createLogger(level);

	// Route debugLog() and trace() through pino — single unified sink.
	initSpineLogger(logger.child({ component: "spine" }));
	initTraceLogger(logger.child({ component: "trace" }));

	return logger;
}

export function createLogger(level?: string): Logger {
	return pino({
		level: level ?? resolveLevel(false),
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
			// Rotate at 10 MB to prevent unbounded growth across long sessions.
			options: { destination: logPath, append: true, size: "10m" },
		},
		base: { pid: process.pid },
		timestamp: pino.stdTimeFunctions.isoTime,
	});
}
