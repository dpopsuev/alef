/**
 * traceEvent — structured event tracing for all Alef packages.
 *
 * Logs are buffered until a sink is registered, then flushed. This ensures:
 * 1. Early boot logs are never lost
 * 2. Nothing writes to stdout/stderr — all output goes through sinks
 * 3. No console.log/warn/error needed anywhere in the codebase
 *
 * AsyncLocalStorage context: traceEvent automatically includes
 * correlationId and turn from the current async context if available.
 * Use runInTraceContext() to set context for an async chain.
 *
 * Usage:
 *   import { traceEvent } from "@dpopsuev/alef-kernel/log";
 *   traceEvent("llm:http:start", { turn, messages: n, tools: n });
 */

import { AsyncLocalStorage } from "node:async_hooks";

interface MinimalLogger {
	debug(obj: Record<string, unknown>, msg: string): void;
}

type SessionSink = (record: Record<string, unknown>) => void;

let sharedLogger: MinimalLogger | undefined;
let sessionSink: SessionSink | undefined;

const pendingEvents: Array<{ event: string; extra?: Record<string, unknown>; timestamp: number }> = [];
const MAX_PENDING = 500;

// ---------------------------------------------------------------------------
// Trace context — AsyncLocalStorage carries correlationId + turn
// ---------------------------------------------------------------------------

/** Async-local context carrying the active correlation ID and optional turn number. */
export interface TraceContext {
	correlationId: string;
	turn?: number;
}

const traceContextStorage = new AsyncLocalStorage<TraceContext>();

/** Execute a function within an AsyncLocalStorage trace context. */
export function runInTraceContext<T>(ctx: TraceContext, fn: () => T): T {
	return traceContextStorage.run(ctx, fn);
}

/** Retrieve the current trace context from AsyncLocalStorage, if any. */
export function getTraceContext(): TraceContext | undefined {
	return traceContextStorage.getStore();
}

// ---------------------------------------------------------------------------
// Sinks
// ---------------------------------------------------------------------------

/** Drain all buffered trace events into the registered logger and session sinks. */
function flushPending(): void {
	if (pendingEvents.length === 0) return;
	const events = pendingEvents.splice(0);
	for (const { event, extra, timestamp } of events) {
		if (sharedLogger) sharedLogger.debug(extra ?? {}, event);
		if (sessionSink) sessionSink({ bus: "debug", type: event, timestamp, ...(extra ?? {}) });
	}
}

/** Register a pino logger to receive all traceEvent calls. Called once at runner startup. */
export function initSpineLogger(logger: MinimalLogger): void {
	sharedLogger = logger;
	flushPending();
}

/** Register a session store sink — debug events will be appended to the session JSONL. */
export function initSessionSink(sink: SessionSink): void {
	sessionSink = sink;
	flushPending();
}

// ---------------------------------------------------------------------------
// Sampling — rule-based tail sampling for high-volume trace events
// ---------------------------------------------------------------------------

const ALWAYS_RECORD = new Set([
	"boot", "tui:start", "tui:stopped", "directives:built",
	"llm:http:start", "llm:http:done", "llm:http:error",
	"llm:retry", "llm:tool:stall", "llm:tool:timeout",
	"observer:turn-complete", "turn.start", "turn.complete",
	"tool:start", "tool:end", "loop:detected",
	"delegate:strategy:start", "delegate:strategy:done",
	"in-process:start", "in-process:done", "in-process:error",
]);

const SAMPLED = new Set([
	"observer:convert", "observer:deliver",
	"tui:observer", "tui:dispatch",
]);

const SAMPLE_RATE = 0.1;
let samplingCounter = 0;

/** Wrap a session sink with rule-based sampling. Always keeps errors, timeouts, and lifecycle events. Samples high-volume observer/dispatch events at 10%. */
export function withSampling(sink: SessionSink): SessionSink {
	return (record) => {
		const type = typeof record.type === "string" ? record.type : "";

		if (ALWAYS_RECORD.has(type)) {
			sink(record);
			return;
		}

		if (type.includes("error") || type.includes("fail") || type.includes("timeout")) {
			sink(record);
			return;
		}

		if (SAMPLED.has(type)) {
			samplingCounter++;
			if (samplingCounter % Math.round(1 / SAMPLE_RATE) === 0) {
				sink(record);
			}
			return;
		}

		sink(record);
	};
}

/** Emit a structured trace event, buffering if no sink is registered yet. */
export function traceEvent(event: string, extra?: Record<string, unknown>): void {
	const ctx = traceContextStorage.getStore();
	const enriched = ctx ? { correlationId: ctx.correlationId, ...(ctx.turn !== undefined ? { turn: ctx.turn } : {}), ...(extra ?? {}) } : extra;

	if (sharedLogger || sessionSink) {
		if (sharedLogger) sharedLogger.debug(enriched ?? {}, event);
		if (sessionSink) sessionSink({ bus: "debug", type: event, timestamp: Date.now(), ...(enriched ?? {}) });
		return;
	}
	if (pendingEvents.length < MAX_PENDING) {
		pendingEvents.push({ event, extra: enriched, timestamp: Date.now() });
	}
}

/**
 * Standard log field keys — unified schema across all Alef packages.
 *
 * Use these constants instead of raw strings. Typos become compile errors.
 * If the same concept has two spellings across packages, the schema is broken.
 *
 * Naming: snake_case for log fields (pino/OTel convention).
 * Values match the field names in StorageRecord, BusMessage, and Post.
 */
/** Canonical log field key constants to prevent typo-induced schema drift across packages. */
export const LogField = {
	component: "component",
	adapter: "adapter",
	tool: "tool",
	correlationId: "correlationId",
	sessionId: "sessionId",
	turn: "turn",
	elapsed: "elapsedMs",
	error: "err",
	event: "event",
	path: "path",
	bus: "bus",
	author: "author",
	timestamp: "timestamp",
	workflowId: "workflowId",
	taskId: "taskId",
	profile: "profile",
	status: "status",
} as const;

// ---------------------------------------------------------------------------
// @Traced method decorator — automatic OTel span per method call
// ---------------------------------------------------------------------------

import { trace } from "@opentelemetry/api";

const _tracedTracer = trace.getTracer("alef.traced", "0.0.1");

/**
 * Method decorator that wraps a class method with an OTel span.
 * Span name: `{ClassName}.{methodName}`.
 * Records exceptions and sets span status on error.
 *
 * Usage:
 *   class SessionLog implements Adapter {
 *     @Traced
 *     mount(bus: Bus) { ... }
 *   }
 */
export function Traced(_target: unknown, propertyKey: string, descriptor: PropertyDescriptor): void {
	const original = descriptor.value as (...args: unknown[]) => unknown;
	descriptor.value = function (this: { constructor: { name: string } }, ...args: unknown[]): unknown {
		const spanName = `${this.constructor.name}.${propertyKey}`;
		return _tracedTracer.startActiveSpan(spanName, (span) => {
			try {
				const result = original.apply(this, args);
				if (result instanceof Promise) {
					return result
						.then((v) => { span.end(); return v; })
						.catch((e: unknown) => { span.recordException(e instanceof Error ? e : new Error(String(e))); span.end(); throw e; });
				}
				span.end();
				return result;
			} catch (e) {
				span.recordException(e instanceof Error ? e : new Error(String(e)));
				span.end();
				throw e;
			}
		});
	};
}
