/**
 * debugLog — shared structured log writer for all Alef packages.
 *
 * Two sinks, registered at boot by the runner entry point:
 *   1. pino logger (initSpineLogger) — stderr in non-TUI, suppressed in TUI
 *   2. session JSONL (initSessionSink) — the persistent source of truth
 *
 * Usage:
 *   import { debugLog } from "@dpopsuev/alef-kernel";
 *   debugLog("llm:http:start", { turn, messages: n, tools: n });
 */

interface MinimalLogger {
	debug(obj: Record<string, unknown>, msg: string): void;
}

type SessionSink = (record: Record<string, unknown>) => void;

let sharedLogger: MinimalLogger | undefined;
let sessionSink: SessionSink | undefined;

/** Register a pino logger to receive all debugLog calls. Called once at runner startup. */
export function initSpineLogger(logger: MinimalLogger): void {
	sharedLogger = logger;
}

/** Register a session store sink — debug events will be appended to the session JSONL. */
export function initSessionSink(sink: SessionSink): void {
	sessionSink = sink;
}

export function debugLog(event: string, extra?: Record<string, unknown>): void {
	if (sharedLogger) {
		sharedLogger.debug(extra ?? {}, event);
	}
	if (sessionSink) {
		sessionSink({
			bus: "debug",
			type: event,
			timestamp: Date.now(),
			...(extra ?? {}),
		});
	}
}
