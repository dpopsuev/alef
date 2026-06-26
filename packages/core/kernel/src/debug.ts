/**
 * traceEvent — structured event tracing for all Alef packages.
 *
 * Logs are buffered until a sink is registered, then flushed. This ensures:
 * 1. Early boot logs are never lost
 * 2. Nothing writes to stdout/stderr — all output goes through sinks
 * 3. No console.log/warn/error needed anywhere in the codebase
 *
 * Usage:
 *   import { traceEvent } from "@dpopsuev/alef-kernel/log";
 *   traceEvent("llm:http:start", { turn, messages: n, tools: n });
 */

interface MinimalLogger {
	debug(obj: Record<string, unknown>, msg: string): void;
}

type SessionSink = (record: Record<string, unknown>) => void;

let sharedLogger: MinimalLogger | undefined;
let sessionSink: SessionSink | undefined;

const pendingEvents: Array<{ event: string; extra?: Record<string, unknown>; timestamp: number }> = [];
const MAX_PENDING = 500;

function flushPending(): void {
	if (pendingEvents.length === 0) return;
	const events = pendingEvents.splice(0);
	for (const { event, extra, timestamp } of events) {
		if (sharedLogger) sharedLogger.debug(extra ?? {}, event);
		if (sessionSink) sessionSink({ bus: "debug", type: event, timestamp, ...(extra ?? {}) });
	}
}

/** Register a pino logger to receive all debugLog calls. Called once at runner startup. */
export function initSpineLogger(logger: MinimalLogger): void {
	sharedLogger = logger;
	flushPending();
}

/** Register a session store sink — debug events will be appended to the session JSONL. */
export function initSessionSink(sink: SessionSink): void {
	sessionSink = sink;
	flushPending();
}

export function traceEvent(event: string, extra?: Record<string, unknown>): void {
	if (sharedLogger || sessionSink) {
		if (sharedLogger) sharedLogger.debug(extra ?? {}, event);
		if (sessionSink) sessionSink({ bus: "debug", type: event, timestamp: Date.now(), ...(extra ?? {}) });
		return;
	}
	if (pendingEvents.length < MAX_PENDING) {
		pendingEvents.push({ event, extra, timestamp: Date.now() });
	}
}

/** @deprecated Use traceEvent */
export const debugLog = traceEvent;
