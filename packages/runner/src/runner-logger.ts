/**
 * Logger utilities for the runner package.
 *
 * Provides convenience wrappers around the structured logger for common
 * runner-specific logging patterns.
 */

import { debugLog } from "@dpopsuev/alef-kernel/log";

/** Minimal logger interface for components that don't need full pino */
export interface MinimalLogger {
	debug(obj: Record<string, unknown>, msg: string): void;
	debug(msg: string): void;
	info(obj: Record<string, unknown>, msg: string): void;
	info(msg: string): void;
	warn(obj: Record<string, unknown>, msg: string): void;
	warn(msg: string): void;
	error(obj: Record<string, unknown>, msg: string): void;
	error(msg: string): void;
}

/**
 * Global runner logger instance.
 * Set once at startup via setRunnerLogger().
 */
let runnerLogger: MinimalLogger | undefined;

/**
 * Initialize the global runner logger.
 * Call once from main.ts after creating the pino logger.
 */
export function setRunnerLogger(logger: MinimalLogger): void {
	runnerLogger = logger;
}

/**
 * Get the runner logger, falling back to debugLog if not initialized.
 * This ensures logging works even before the full logger is set up.
 */
export function getRunnerLogger(): MinimalLogger {
	if (runnerLogger) {
		return runnerLogger;
	}

	// Fallback logger using debugLog
	return {
		debug: (objOrMsg: Record<string, unknown> | string, msg?: string) => {
			if (typeof objOrMsg === "string") {
				debugLog("runner:debug", { message: objOrMsg });
			} else {
				debugLog("runner:debug", { ...objOrMsg, message: msg });
			}
		},
		info: (objOrMsg: Record<string, unknown> | string, msg?: string) => {
			if (typeof objOrMsg === "string") {
				debugLog("runner:info", { message: objOrMsg });
			} else {
				debugLog("runner:info", { ...objOrMsg, message: msg });
			}
		},
		warn: (objOrMsg: Record<string, unknown> | string, msg?: string) => {
			if (typeof objOrMsg === "string") {
				debugLog("runner:warn", { message: objOrMsg });
			} else {
				debugLog("runner:warn", { ...objOrMsg, message: msg });
			}
		},
		error: (objOrMsg: Record<string, unknown> | string, msg?: string) => {
			if (typeof objOrMsg === "string") {
				debugLog("runner:error", { message: objOrMsg });
			} else {
				debugLog("runner:error", { ...objOrMsg, message: msg });
			}
		},
	};
}

/**
 * Log a warning about organ configuration issues.
 */
export function logAdapterWarning(adapterName: string, message: string, context?: Record<string, unknown>): void {
	const logger = getRunnerLogger();
	logger.warn({ adapter: adapterName, ...context }, message);
}

/**
 * Log a warning about blueprint/agent loading issues.
 */
export function logBlueprintWarning(message: string, context?: Record<string, unknown>): void {
	const logger = getRunnerLogger();
	logger.warn({ component: "blueprint", ...context }, message);
}

/**
 * Log a warning about port registry issues.
 */
export function logPortWarning(message: string, context?: Record<string, unknown>): void {
	const logger = getRunnerLogger();
	logger.warn({ component: "port-registry", ...context }, message);
}

/**
 * Log a warning about model/credentials configuration.
 */
export function logModelWarning(message: string, context?: Record<string, unknown>): void {
	const logger = getRunnerLogger();
	logger.warn({ component: "model", ...context }, message);
}
