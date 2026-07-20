import { initTraceLogger } from "@dpopsuev/alef-kernel/log";
import { debugLogPath } from "@dpopsuev/alef-kernel/xdg";
import type { Logger } from "pino";
import pino from "pino";

export type { Logger };

/** Determine the pino log level from the debug flag and environment variables. */
function resolveLevel(debug: boolean): string {
	if (debug) return "debug";
	if (process.env.ALEF_DEBUG === "1") return "debug";
	return process.env.ALEF_LOG_LEVEL ?? "warn";
}

/**
 * Create the main runner logger.
 * When TUI is active without --debug, pino is silenced entirely.
 * When TUI is active WITH --debug, pino writes to $XDG_STATE_HOME/alef/debug.log
 * instead of stderr — fd 2 stays clean for the alternate screen buffer.
 */
export function createRunnerLogger(willUseTui: boolean, debug: boolean): Logger {
	const level = willUseTui && !debug ? "silent" : resolveLevel(debug);
	const logFile = willUseTui && level !== "silent" ? debugLogPath() : undefined;
	const logger = createLogger(level, logFile);
	initTraceLogger(logger.child({ component: "kernel" }));
	return logger;
}

/** Create a pino logger. Writes to `logFile` when provided, stderr otherwise. */
export function createLogger(level?: string, logFile?: string): Logger {
	if (logFile) {
		return pino({
			level: level ?? resolveLevel(false),
			transport: { target: "pino/file", options: { destination: logFile, mkdir: true } },
			base: { pid: process.pid },
			timestamp: pino.stdTimeFunctions.isoTime,
		});
	}
	const useTransport = process.stderr.isTTY;
	return pino({
		level: level ?? resolveLevel(false),
		transport: useTransport ? { target: "pino/file", options: { destination: 2 } } : undefined,
		...(useTransport ? {} : { destination: 2 }),
		base: { pid: process.pid },
		timestamp: pino.stdTimeFunctions.isoTime,
	});
}
