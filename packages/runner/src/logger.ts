import type { Logger } from "pino";
import pino from "pino";
import { debugLogPath } from "./debug-trace.js";

export type { Logger };

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
