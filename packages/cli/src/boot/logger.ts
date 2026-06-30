import { initSpineLogger } from "@dpopsuev/alef-kernel/log";
import type { Logger } from "pino";
import pino from "pino";

export type { Logger };

/** Determine the pino log level from the debug flag and environment variables. */
function resolveLevel(debug: boolean): string {
	if (debug) return "debug";
	if (process.env.ALEF_DEBUG === "1") return "debug";
	return process.env.ALEF_LOG_LEVEL ?? "warn";
}

/** Create the main runner logger, silencing output when TUI is active unless debug is on. */
export function createRunnerLogger(willUseTui: boolean, debug: boolean): Logger {
	const level = willUseTui && !debug ? "silent" : resolveLevel(debug);
	const logger = createLogger(level);
	initSpineLogger(logger.child({ component: "spine" }));
	return logger;
}

/** Create a pino logger writing to stderr with the given level. */
export function createLogger(level?: string): Logger {
	return pino({
		level: level ?? resolveLevel(false),
		transport: process.stderr.isTTY ? { target: "pino/file", options: { destination: 2 } } : undefined,
		...(process.stderr.isTTY ? {} : { destination: 2 }),
		base: { pid: process.pid },
		timestamp: pino.stdTimeFunctions.isoTime,
	});
}
