/**
 * ViewMode — Strategy interface for all UI surfaces that attach to a Session.
 *
 * A viewer does two things:
 *   1. Subscribes to session.subscribe to receive AgentEvents (output side)
 *   2. Drives session.send / session.receive to deliver user input (input side)
 *
 * The Dialog Adapter sits between the viewer and the bus — the viewer never
 * touches the bus directly. session.send() → AgentController → event/llm.input.
 *
 * Implementations:
 *   HeadlessViewMode  — in-process, records events, exposes typed assertions
 *   TuiViewMode       — ANSI terminal, keyboard-driven
 *   PrintViewMode     — single prompt → stdout reply → exit
 *   JsonViewMode      — JSONL event stream on stdout
 */

import type { SessionStore } from "@dpopsuev/alef-session";
import type { Args } from "./args.js";
import type { InteractiveOptions } from "./interactive.js";
import type { AgentEvent, Session } from "./session.js";

// ---------------------------------------------------------------------------
// Core interface
// ---------------------------------------------------------------------------

export interface ViewMode {
	run(session: Session): Promise<void>;
}

// ---------------------------------------------------------------------------
// HeadlessViewMode
//
// In-process viewer for tests and programmatic use. Records every AgentEvent,
// exposes typed accessors for assertions, and lets the caller drive input via
// send() without needing a real TTY or HTTP endpoint.
//
// Pattern: Observer (session.subscribe) + typed query methods.
// ---------------------------------------------------------------------------

export class HeadlessViewMode implements ViewMode {
	private readonly _events: AgentEvent[] = [];
	private _session: Session | null = null;
	private _resolve: (() => void) | null = null;
	private _unsubscribe: (() => void) | null = null;

	run(session: Session): Promise<void> {
		this._session = session;
		this._unsubscribe = session.subscribe((event) => this._events.push(event));
		return new Promise<void>((resolve) => {
			this._resolve = resolve;
		});
	}

	/** Send a message and await the full reply text. */
	async send(text: string, timeoutMs = 30_000): Promise<string> {
		const session = this._session;
		if (!session?.send) throw new Error("HeadlessViewMode: session not running or send not available");
		return session.send(text, timeoutMs);
	}

	/** Fire-and-forget input (no reply awaited). */
	inject(text: string): void {
		this._session?.receive?.(text);
	}

	/** Resolve run() — call when the test is done with the session. */
	complete(): void {
		this._unsubscribe?.();
		this._resolve?.();
		this._session?.dispose();
		this._unsubscribe = null;
		this._resolve = null;
		this._session = null;
	}

	// ---------------------------------------------------------------------------
	// Event accessors
	// ---------------------------------------------------------------------------

	get events(): readonly AgentEvent[] {
		return this._events;
	}

	eventsOfType<T extends AgentEvent["type"]>(type: T): Extract<AgentEvent, { type: T }>[] {
		return this._events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type);
	}

	replies(): string[] {
		return this.eventsOfType("turn-complete").map((e) => e.reply);
	}

	chunks(): string[] {
		return this.eventsOfType("chunk").map((e) => e.text);
	}

	toolStarts(): Array<{ callId: string; name: string; args: Record<string, unknown> }> {
		return this.eventsOfType("tool-start");
	}

	toolEnds(): Array<{ callId: string; elapsedMs: number; ok: boolean }> {
		return this.eventsOfType("tool-end");
	}

	errors(): string[] {
		return this.eventsOfType("turn-error").map((e) => e.message);
	}

	lastReply(): string | undefined {
		const turns = this.eventsOfType("turn-complete");
		return turns[turns.length - 1]?.reply;
	}
}

// ---------------------------------------------------------------------------
// TuiViewMode — wraps runTuiMode
// ---------------------------------------------------------------------------

export class TuiViewMode implements ViewMode {
	constructor(
		private readonly opts: Omit<InteractiveOptions, never>,
		private readonly store?: SessionStore,
	) {}

	async run(session: Session): Promise<void> {
		const { runTuiMode } = await import("./cli/tui-mode.js");
		await runTuiMode(session, this.opts, this.store);
	}
}

// ---------------------------------------------------------------------------
// PrintViewMode — wraps runPrintMode
// ---------------------------------------------------------------------------

export class PrintViewMode implements ViewMode {
	constructor(private readonly prompt: string) {}

	async run(session: Session): Promise<void> {
		const { runPrintMode } = await import("./print-mode.js");
		await runPrintMode(this.prompt, session);
	}
}

// ---------------------------------------------------------------------------
// JsonViewMode — wraps runInteractive in json/headless mode
// ---------------------------------------------------------------------------

export class JsonViewMode implements ViewMode {
	constructor(private readonly opts: InteractiveOptions) {}

	async run(session: Session): Promise<void> {
		const { runInteractive } = await import("./interactive.js");
		await runInteractive(session, this.opts);
	}
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function selectViewMode(args: Args, interactiveOpts: InteractiveOptions, store?: SessionStore): ViewMode {
	if (args.print) return new PrintViewMode(args.prompt);

	const useTui = !args.json && !args.noTui && process.stdin.isTTY;
	if (useTui) return new TuiViewMode(interactiveOpts, store);

	return new JsonViewMode(interactiveOpts);
}
