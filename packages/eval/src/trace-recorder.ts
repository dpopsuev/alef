/**
 * TraceRecorder \u2014 JSONL execution trace to disk for eval runs.
 *
 * Implements BusObserver so it can be attached via agent.observe().
 * Writes one TraceEvent per Motor and Sense event as JSONL.
 *
 * Every Motor event = a tool dispatch (level: debug).
 * Every Sense event = a tool result (level: debug, or warn on isError).
 * Session lifecycle signals (start/end) = info level.
 *
 * LoadTrace(path) reads the JSONL back for post-hoc analysis.
 * Summarize(events) computes per-tool timing, error counts, path.
 * AssertPath(events, tools) asserts the tool sequence as an in-order
 * subsequence \u2014 the highest-signal eval assertion.
 *
 * Mirrors Tako engine/trace.TraceRecorder + observe.Summarize
 * + testkit/assertions.AssertPath.
 */

import { createWriteStream, type WriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import type { BusMessage } from "@dpopsuev/alef-kernel";

import type { BusObserver } from "@dpopsuev/alef-runtime";

// ---------------------------------------------------------------------------
// TraceEvent \u2014 one JSONL line
// ---------------------------------------------------------------------------

export type TraceLevel = "info" | "debug" | "warn";

export interface TraceEvent {
	/** RFC3339Nano timestamp. */
	ts: string;
	level: TraceLevel;
	/** Motor event type (e.g. "fs.read") or Sense event type or lifecycle signal. */
	event: string;
	/** "motor" | "sense" | "signal". */
	bus: "motor" | "sense" | "signal";
	/** Correlation ID threading Motor\u2192Sense pairs. */
	correlationId?: string;
	/** True when the Sense event carries isError:true. */
	isError?: true;
	/** Error message if isError. */
	errorMessage?: string;
	/** Cache hit (from alef.cache.hit Sense attribute, if known). */
	cacheHit?: boolean;
	/** Elapsed ms between paired Motor and Sense events. */
	elapsedMs?: number;
	/** Arbitrary metadata. */
	meta?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// TraceRecorder
// ---------------------------------------------------------------------------

export class TraceRecorder implements BusObserver {
	private readonly stream: WriteStream;
	private readonly motorTimes = new Map<string, number>(); // correlationId \u2192 ms
	private count = 0;

	constructor(path: string) {
		this.stream = createWriteStream(path, { flags: "w", encoding: "utf-8" });
	}

	onMotorEvent(event: BusMessage): void {
		const p = event as unknown as { type?: string; correlationId?: string; payload?: Record<string, unknown> };
		const type = p.type ?? "unknown";
		// Skip internal dialog events \u2014 not tool calls
		if (type === "llm.response") return;
		this.motorTimes.set(p.correlationId ?? "", Date.now());
		this.write({
			ts: new Date().toISOString(),
			level: "debug",
			event: type,
			bus: "motor",
			correlationId: p.correlationId,
		});
	}

	onSenseEvent(event: BusMessage): void {
		const p = event as unknown as {
			type?: string;
			correlationId?: string;
			isError?: boolean;
			errorMessage?: string;
			payload?: Record<string, unknown>;
		};
		const type = p.type ?? "unknown";
		if (type === "llm.input") return;

		const startMs = this.motorTimes.get(p.correlationId ?? "");
		const elapsedMs = startMs !== undefined ? Date.now() - startMs : undefined;
		if (startMs !== undefined) this.motorTimes.delete(p.correlationId ?? "");

		const te: TraceEvent = {
			ts: new Date().toISOString(),
			level: p.isError ? "warn" : "debug",
			event: type,
			bus: "sense",
			correlationId: p.correlationId,
			...(elapsedMs !== undefined && { elapsedMs }),
			...(p.isError && { isError: true }),
			...(p.errorMessage && { errorMessage: p.errorMessage }),
		};

		const payload = p.payload ?? {};
		if (typeof payload["alef.cache.hit"] === "boolean") {
			te.cacheHit = payload["alef.cache.hit"] as boolean;
		}

		this.write(te);
	}

	/** Write an info-level lifecycle signal (session_start, session_end, etc.). */
	signal(event: string, meta?: Record<string, unknown>): void {
		this.write({
			ts: new Date().toISOString(),
			level: "info",
			event,
			bus: "signal",
			...(meta && { meta }),
		});
	}

	/** Total events written so far. */
	get eventCount(): number {
		return this.count;
	}

	/** Flush and close the file. Idempotent. */
	close(): Promise<void> {
		return new Promise((resolve, reject) => {
			this.stream.end((err: Error | null | undefined) => {
				if (err) reject(err);
				else resolve();
			});
		});
	}

	private write(te: TraceEvent): void {
		this.stream.write(`${JSON.stringify(te)}\n`);
		this.count++;
	}
}

// ---------------------------------------------------------------------------
// LoadTrace \u2014 read JSONL back from disk
// ---------------------------------------------------------------------------

export async function loadTrace(path: string): Promise<TraceEvent[]> {
	const raw = await readFile(path, "utf-8");
	const events: TraceEvent[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			events.push(JSON.parse(line) as TraceEvent);
		} catch {
			/* skip malformed lines */
		}
	}
	return events;
}

// ---------------------------------------------------------------------------
// TraceSummary + Summarize
// ---------------------------------------------------------------------------

export interface ToolSummary {
	name: string;
	calls: number;
	errors: number;
	cacheHits: number;
	/** Mean elapsed ms across paired Motor\u2192Sense events. */
	meanElapsedMs: number;
}

export interface TraceSummary {
	totalEvents: number;
	/** Motor tool calls in execution order. */
	path: string[];
	tools: ToolSummary[];
	errors: TraceEvent[];
	/** Total wall-clock duration first\u2192last event in ms. */
	durationMs: number;
}

export function summarizeTrace(events: TraceEvent[]): TraceSummary {
	const path: string[] = [];
	const toolMap = new Map<string, { calls: number; errors: number; hits: number; totalMs: number; count: number }>();
	const errors: TraceEvent[] = [];

	for (const e of events) {
		if (e.bus === "motor") {
			path.push(e.event);
			if (!toolMap.has(e.event)) toolMap.set(e.event, { calls: 0, errors: 0, hits: 0, totalMs: 0, count: 0 });
			const tm = toolMap.get(e.event);
			if (tm) tm.calls++;
		}
		if (e.bus === "sense") {
			if (e.isError) {
				errors.push(e);
				const t = toolMap.get(e.event);
				if (t) t.errors++;
			}
			if (e.cacheHit) {
				const t = toolMap.get(e.event);
				if (t) t.hits++;
			}
			if (e.elapsedMs !== undefined) {
				const t = toolMap.get(e.event);
				if (t) {
					t.totalMs += e.elapsedMs;
					t.count++;
				}
			}
		}
	}

	const tools: ToolSummary[] = [...toolMap.entries()].map(([name, v]) => ({
		name,
		calls: v.calls,
		errors: v.errors,
		cacheHits: v.hits,
		meanElapsedMs: v.count > 0 ? Math.round(v.totalMs / v.count) : 0,
	}));

	let durationMs = 0;
	if (events.length >= 2) {
		const first = new Date(events[0].ts).getTime();
		const last = new Date(events[events.length - 1].ts).getTime();
		durationMs = last - first;
	}

	return { totalEvents: events.length, path, tools, errors, durationMs };
}

// ---------------------------------------------------------------------------
// AssertPath
// ---------------------------------------------------------------------------

/**
 * Assert that the agent called tools in the expected sequence.
 * Checks that expectedTools is an in-order subsequence of the actual
 * tool call path \u2014 not an exact match, so intermediate tools are allowed.
 *
 * Throws with a descriptive diff if the sequence is violated.
 *
 * @example
 * assertPath(events, ["fs.read", "fs.edit"]);
 * // passes if agent called: fs.read \u2192 [fs.grep] \u2192 fs.edit
 * // fails if agent called: fs.grep \u2192 fs.edit  (no fs.read before edit)
 */
export function assertPath(events: TraceEvent[], expectedTools: string[]): void {
	const actual = events.filter((e) => e.bus === "motor").map((e) => e.event);

	let ei = 0;
	for (const expected of expectedTools) {
		const found = actual.indexOf(expected, ei) - ei;
		if (found === -1) {
			throw new Error(
				`[assertPath] Expected tool "${expected}" after position ${ei} in path.\n` +
					`  Expected sequence: [${expectedTools.join(" \u2192 ")}]\n` +
					`  Actual path:       [${actual.join(" \u2192 ")}]`,
			);
		}
		ei += found + 1;
	}
}

/**
 * Assert that a specific tool was called at least once.
 * Simpler than assertPath when order doesn't matter.
 */
export function assertToolInTrace(events: TraceEvent[], toolName: string): void {
	const called = events.some((e) => e.bus === "motor" && e.event === toolName);
	if (!called) {
		const actual = events.filter((e) => e.bus === "motor").map((e) => e.event);
		throw new Error(
			`[assertToolInTrace] Tool "${toolName}" was not called.\n` + `  Actual path: [${actual.join(" \u2192 ")}]`,
		);
	}
}
