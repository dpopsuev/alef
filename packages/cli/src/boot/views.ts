/**
 * ViewMode -- Strategy interface for all UI surfaces that attach to a Session.
 *
 * A viewer does two things:
 *   1. Subscribes to session.subscribe to receive AgentEvents (output side)
 *   2. Drives session.send / session.receive to deliver user input (input side)
 *
 * The Dialog Adapter sits between the viewer and the bus -- the viewer never
 * touches the bus directly. session.send() -> AgentController -> event/llm.input.
 *
 * Implementations:
 *   HeadlessViewMode  -- in-process, records events, exposes typed assertions
 *   TuiViewMode       -- ANSI terminal, keyboard-driven
 *   PrintViewMode     -- single prompt -> stdout reply -> exit
 *   ServeViewMode     -- HTTP/SSE only; parks until stop (never disposes session)
 *   JsonViewMode      -- JSONL event stream on stdout
 */

import type { AgentEvent, Session } from "@dpopsuev/alef-session/contracts";
import type { SessionStore } from "@dpopsuev/alef-session/storage";
import type { Terminal } from "@dpopsuev/alef-tui";
import type { Args } from "../boot/args.js";
import type { InteractiveOptions } from "../client/boot-types.js";

// ---------------------------------------------------------------------------
// Core interface
// ---------------------------------------------------------------------------

/** Strategy interface for UI surfaces that attach to a Session for input/output. */
export interface ViewMode {
	run(session: Session): Promise<void>;
}

/** In-process viewer for tests -- records events, exposes typed query methods, no TTY needed. */
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

	/** Resolve run() -- call when the test is done with the session. */
	complete(): void {
		this._unsubscribe?.();
		this._resolve?.();
		void this._session?.dispose();
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
// TuiViewMode -- calls bootTuiShell + wireSession directly
// ---------------------------------------------------------------------------

/** ANSI terminal view mode backed by the full TUI renderer (bootTuiShell + wireSession). */
export class TuiViewMode implements ViewMode {
	constructor(
		private readonly opts: InteractiveOptions & { terminal?: Terminal },
		private readonly store?: SessionStore,
	) {}

	async run(session: Session): Promise<void> {
		const { bootTuiShell, wireSession } = await import("../client/tui-shell.js");
		const { getUiSignalHandlers, isCompacted } = await import("./session.js");
		const { getRebootPort, getRestartStrategy } = await import("./reboot-port.js");
		const { traceEvent } = await import("@dpopsuev/alef-kernel/log");

		const shell = await bootTuiShell({ cwd: this.opts.cwd, terminal: this.opts.terminal });

		wireSession(
			shell,
			{
				session,
				store: this.store,
				sessionId: this.opts.sessionId,
				modelId: this.opts.modelId,
				contextWindow: this.opts.contextWindow ?? session.state.contextWindow,
				isNew: !this.store,
				getModel: this.opts.getModel ?? (() => this.opts.modelId),
				setModel: this.opts.setModel ?? (() => {}),
				getThinking: this.opts.getThinking ?? (() => session.getThinking()),
				setThinking: this.opts.setThinking ?? (() => {}),
				humanAddress: this.opts.humanAddress ?? "@you",
				agentAddress: this.opts.agentAddress ?? "@alef",
				blueprintName: this.opts.blueprintName,
			},
			{
				signalHandlers: getUiSignalHandlers(),
				isCompacted,
				rebootPort: getRebootPort(),
				restartStrategy: getRestartStrategy(),
				checkForUpdate: () => import("./version-check.js").then((m) => m.checkForUpdate()),
			},
		);

		await shell.stopped;
		if (shell.input.promptConsole.isThinking) shell.input.promptConsole.stopThinking();
		traceEvent("tui:stopped");
	}
}

// ---------------------------------------------------------------------------
// PrintViewMode -- wraps runPrintMode
// ---------------------------------------------------------------------------

/** Single-prompt view mode that sends one message, prints the reply, and exits. */
export class PrintViewMode implements ViewMode {
	constructor(private readonly prompt: string) {}

	async run(session: Session): Promise<void> {
		const { runPrintMode } = await import("./print.js");
		await runPrintMode(this.prompt, session);
	}
}

// ---------------------------------------------------------------------------
// ServeViewMode -- HTTP/SSE only; never disposes the session
// ---------------------------------------------------------------------------

/**
 * Parks until stop() -- used for --serve / --daemon headless mode.
 * Must not call session.dispose(); the supervisor owns session lifetime.
 */
export class ServeViewMode implements ViewMode {
	private _resolve: (() => void) | null = null;

	run(_session: Session): Promise<void> {
		return new Promise<void>((resolve) => {
			this._resolve = resolve;
		});
	}

	/** Unblock run(); does not dispose the session. */
	stop(): void {
		this._resolve?.();
		this._resolve = null;
	}
}

// ---------------------------------------------------------------------------
// JsonViewMode -- wraps runInteractive in json/headless mode
// ---------------------------------------------------------------------------

/** JSONL event stream view mode for machine-readable stdout output. */
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

/** True when CLI should run HTTP-only without a stdin-driven viewer. */
export function isHeadlessServe(
	args: Pick<Args, "serve" | "print" | "noTui">,
	stdinIsTty = process.stdin.isTTY,
): boolean {
	return args.serve !== undefined && !args.print && (args.noTui || !stdinIsTty);
}

/** Choose the appropriate view mode based on CLI flags and TTY state. */
export function selectViewMode(args: Args, interactiveOpts: InteractiveOptions, store?: SessionStore): ViewMode {
	if (args.print) return new PrintViewMode(args.prompt);

	if (isHeadlessServe(args)) return new ServeViewMode();

	const useTui = !args.json && !args.noTui && process.stdin.isTTY;
	if (useTui) return new TuiViewMode(interactiveOpts, store);

	return new JsonViewMode(interactiveOpts);
}
