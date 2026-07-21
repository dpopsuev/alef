/**
 * Session replay infrastructure for TUI rendering tests.
 *
 * Pattern (inspired by charmbracelet/teatest golden-file testing):
 *
 *   1. SessionRecorder captures TuiEvents with timestamps during a live or
 *      synthetic session run.
 *   2. SessionReplayer feeds those events back through dispatchTuiEvent at
 *      recorded timing, driving the real TUI render pipeline.
 *   3. RenderRecorder (from tui/test/) captures every emitted frame.
 *   4. Tests assert invariants across the full frame history.
 *
 * This lets us test the actual dispatch -> applyIntents -> requestRender ->
 * doRenderDocked -> terminal.write pipeline with realistic event sequences
 * -- including timing-dependent races between tool-chunk, thinking-tick,
 * and SlotMachine animation.
 */

import type { AgentEvent } from "@dpopsuev/alef-session/contracts";
import type { TuiEvent } from "../src/client/events.js";

/** A recorded event with a relative timestamp (ms from session start). */
export interface RecordedEvent {
	/** Milliseconds since session start. */
	offsetMs: number;
	/** The event payload. */
	event: TuiEvent;
}

/** A complete recording that can be replayed. */
export interface SessionRecording {
	/** Human-readable label. */
	label: string;
	/** Recorded events in chronological order. */
	events: RecordedEvent[];
}

// ---------------------------------------------------------------------------
// Recorder
// ---------------------------------------------------------------------------

/** Captures TuiEvents with timestamps for later replay. */
export class SessionRecorder {
	private readonly events: RecordedEvent[] = [];
	private readonly startedAt: number;

	constructor() {
		this.startedAt = Date.now();
	}

	/** Record an event at the current time. */
	record(event: TuiEvent): void {
		this.events.push({
			offsetMs: Date.now() - this.startedAt,
			event,
		});
	}

	/** Export the recording. */
	toRecording(label: string): SessionRecording {
		return { label, events: [...this.events] };
	}
}

// ---------------------------------------------------------------------------
// Replayer
// ---------------------------------------------------------------------------

export interface ReplayOptions {
	/** Scale factor for timing (1.0 = real-time, 0 = instant). Default: 0 */
	timeScale?: number;
	/** Maximum delay between events in ms (caps long pauses). Default: 500 */
	maxDelayMs?: number;
	/** Called for each event before dispatch. */
	onEvent?: (event: TuiEvent, offsetMs: number) => void;
}

/**
 * Replay a recording through a dispatch function.
 * Returns after all events have been dispatched.
 */
export async function replaySession(
	recording: SessionRecording,
	dispatch: (event: TuiEvent) => void,
	opts: ReplayOptions = {},
): Promise<void> {
	const timeScale = opts.timeScale ?? 0;
	const maxDelay = opts.maxDelayMs ?? 500;

	let prevOffset = 0;
	for (const entry of recording.events) {
		const rawDelay = (entry.offsetMs - prevOffset) * timeScale;
		const delay = Math.min(rawDelay, maxDelay);
		if (delay > 0) {
			await new Promise<void>((r) => setTimeout(r, delay));
		}
		opts.onEvent?.(entry.event, entry.offsetMs);
		dispatch(entry.event);
		prevOffset = entry.offsetMs;
	}
}

// ---------------------------------------------------------------------------
// Synthetic session builders
// ---------------------------------------------------------------------------

/**
 * Build a synthetic recording that simulates a shell.exec tool call
 * with streaming stdout output -- the scenario most likely to trigger
 * spinner/separator collision.
 */
export function buildShellExecRecording(opts?: {
	/** Number of stdout chunks. Default: 30 */
	chunkCount?: number;
	/** Interval between chunks in ms. Default: 50 */
	chunkIntervalMs?: number;
	/** Whether to include thinking chunks interleaved. Default: true */
	interleaveThinking?: boolean;
	/** Simulated command. Default: "npm test" */
	command?: string;
}): SessionRecording {
	const chunkCount = opts?.chunkCount ?? 30;
	const interval = opts?.chunkIntervalMs ?? 50;
	const interleave = opts?.interleaveThinking ?? true;
	const command = opts?.command ?? "npm test";
	const callId = "call-shell-1";

	const events: RecordedEvent[] = [];
	let t = 0;

	// Turn start
	events.push({ offsetMs: t, event: { type: "chunk", text: "" } as AgentEvent });
	t += 10;

	// Thinking before tool call
	if (interleave) {
		events.push({ offsetMs: t, event: { type: "thinking", text: "Let me run the tests..." } as AgentEvent });
		t += 50;
	}

	// Tool start
	events.push({
		offsetMs: t,
		event: { type: "tool-start", callId, name: "shell.exec", args: { command } } as AgentEvent,
	});
	t += 20;

	// Stream stdout chunks
	for (let i = 0; i < chunkCount; i++) {
		events.push({
			offsetMs: t,
			event: { type: "tool-chunk", callId, text: `PASS test/unit-${i}.test.ts (${i * 12 + 5}ms)\n` } as AgentEvent,
		});
		t += interval;

		// Occasional thinking interleave (like real sessions)
		if (interleave && i % 7 === 3) {
			events.push({
				offsetMs: t,
				event: { type: "thinking", text: `Processing test ${i}...` } as AgentEvent,
			});
			t += 10;
		}
	}

	// Tool end
	events.push({
		offsetMs: t,
		event: {
			type: "tool-end",
			callId,
			elapsedMs: t,
			ok: true,
			display: `exit 0 (${chunkCount} tests)`,
		} as AgentEvent,
	});
	t += 50;

	// Reply
	events.push({
		offsetMs: t,
		event: { type: "chunk", text: `All ${chunkCount} tests passed.` } as AgentEvent,
	});
	t += 20;

	// Turn complete
	events.push({
		offsetMs: t,
		event: { type: "turn-complete", reply: `All ${chunkCount} tests passed.` } as AgentEvent,
	});

	return { label: `shell.exec ${command} (${chunkCount} chunks)`, events };
}

/**
 * Build a recording that simulates multiple concurrent tool calls --
 * e.g., agent.run spawning subagents that each run shell.exec.
 */
export function buildConcurrentToolsRecording(opts?: {
	/** Number of concurrent tools. Default: 3 */
	toolCount?: number;
	/** Chunks per tool. Default: 10 */
	chunksPerTool?: number;
}): SessionRecording {
	const toolCount = opts?.toolCount ?? 3;
	const chunksPerTool = opts?.chunksPerTool ?? 10;

	const events: RecordedEvent[] = [];
	let t = 0;

	// Start all tools
	for (let i = 0; i < toolCount; i++) {
		events.push({
			offsetMs: t,
			event: {
				type: "tool-start",
				callId: `call-${i}`,
				name: i === 0 ? "shell.exec" : "fs.read",
				args: { command: `task-${i}` },
			} as AgentEvent,
		});
		t += 20;
	}

	// Interleave chunks from all tools
	for (let chunk = 0; chunk < chunksPerTool; chunk++) {
		for (let i = 0; i < toolCount; i++) {
			events.push({
				offsetMs: t,
				event: { type: "tool-chunk", callId: `call-${i}`, text: `tool-${i} output line ${chunk}\n` } as AgentEvent,
			});
			t += 15;
		}
		t += 30;
	}

	// End all tools
	for (let i = 0; i < toolCount; i++) {
		events.push({
			offsetMs: t,
			event: { type: "tool-end", callId: `call-${i}`, elapsedMs: t, ok: true } as AgentEvent,
		});
		t += 20;
	}

	events.push({ offsetMs: t, event: { type: "turn-complete", reply: "Done." } as AgentEvent });

	return { label: `${toolCount} concurrent tools`, events };
}

/**
 * Build a recording that simulates rapid card add/remove cycling --
 * exercises the dock-reflow render path repeatedly.
 */
export function buildCardCycleRecording(opts?: {
	/** Number of add/remove cycles. Default: 5 */
	cycles?: number;
	/** Duration of each tool in ms. Default: 200 */
	toolDurationMs?: number;
}): SessionRecording {
	const cycles = opts?.cycles ?? 5;
	const duration = opts?.toolDurationMs ?? 200;

	const events: RecordedEvent[] = [];
	let t = 0;

	for (let i = 0; i < cycles; i++) {
		const callId = `call-cycle-${i}`;
		events.push({
			offsetMs: t,
			event: { type: "tool-start", callId, name: "shell.exec", args: { command: `cmd-${i}` } } as AgentEvent,
		});
		t += 30;

		// A few chunks during the tool
		for (let c = 0; c < 3; c++) {
			events.push({
				offsetMs: t,
				event: { type: "tool-chunk", callId, text: `cycle-${i} chunk-${c}\n` } as AgentEvent,
			});
			t += duration / 3;
		}

		events.push({
			offsetMs: t,
			event: { type: "tool-end", callId, elapsedMs: duration, ok: true } as AgentEvent,
		});
		t += 50;
	}

	events.push({ offsetMs: t, event: { type: "turn-complete", reply: "Done." } as AgentEvent });

	return { label: `${cycles} card cycles`, events };
}
