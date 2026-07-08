/** Pluggable trace sink so the TUI can emit traceEvents without depending on kernel. */
let _sink: ((event: string, extra?: Record<string, unknown>) => void) | undefined;

/** Register a trace sink (called once by the CLI runner). */
export function setTraceSink(sink: (event: string, extra?: Record<string, unknown>) => void): void {
	_sink = sink;
}

/** Emit a trace event through the registered sink (no-op if no sink registered). */
export function traceEvent(event: string, extra?: Record<string, unknown>): void {
	_sink?.(event, extra);
}
