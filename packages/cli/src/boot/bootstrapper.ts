/**
 * Bootstrapper -- process entry point coordinator.
 *
 * Thin orchestrator that starts the TUI and Foundry runtime in parallel,
 * wires lifecycle events between them, and drives the sequential boot
 * spine: storage -> session pick -> adapters -> model -> agent.
 *
 * The Bootstrapper owns no business logic. It starts things and pipes events.
 *
 *   Bootstrapper
 *     |-- starts TUI (immediate: splash + greeter)
 *     |-- starts Foundry runtime (storage, scheduler)
 *     |-- barrier: storage ready
 *     |-- session pick (TUI input area)
 *     |-- adapters / model / agent (lifecycle events -> TUI)
 *     '-- conversation mode (agent events -> TUI)
 */

export type { BootEvent } from "../client/boot-types.js";

import type {
	BootEvent,
	ResolvedSession,
	SessionSelection,
	TuiShell,
	TuiShellContext,
	WireSessionDeps,
} from "../client/boot-types.js";

// ---------------------------------------------------------------------------
// Lifecycle event pub/sub
// ---------------------------------------------------------------------------

/** Callback that receives boot lifecycle events for progress display. */
export type BootEventListener = (event: BootEvent) => void;

/**
 * Boot phase handle -- allows the TUI to observe and interact with the boot process.
 *
 * The Bootstrapper returns this immediately so the TUI can subscribe to
 * lifecycle events before any async work starts.
 */
export interface BootHandle {
	/** Subscribe to boot lifecycle events. Returns unsubscribe function. */
	subscribe(listener: BootEventListener): () => void;
	/** Resolves when the boot sequence completes (agent is ready). */
	readonly done: Promise<void>;
}

// ---------------------------------------------------------------------------
// Bootstrapper dependencies -- injected, never imported by the Bootstrapper
// ---------------------------------------------------------------------------

/** Factory that creates and starts the TUI shell. */
export type TuiShellFactory = (ctx: TuiShellContext) => Promise<TuiShell>;

/** Factory that wires a resolved session into the TUI shell. */
export type SessionWirer = (shell: TuiShell, resolved: ResolvedSession, deps: WireSessionDeps) => void;

/**
 * Pick or create a session.
 * Receives the TUI shell (null when headless) for rendering the picker.
 */
export type SessionPicker = (shell: TuiShell | null) => Promise<SessionSelection>;

/**
 * Resolve a session selection into a fully wired agent session.
 * Handles adapter loading, model resolution, agent assembly.
 */
export type SessionResolver = (selection: SessionSelection) => Promise<ResolvedSession>;

/** Provider for the WireSessionDeps that the TUI needs. */
export type DepsProvider = () => WireSessionDeps;

/** Everything the Bootstrapper needs to coordinate the boot sequence. */
export interface BootstrapperConfig {
	cwd: string;
	willUseTui: boolean;
	createShell: TuiShellFactory;
	wireSession: SessionWirer;
	pickSession: SessionPicker;
	resolveSession: SessionResolver;
	getDeps: DepsProvider;
}

// ---------------------------------------------------------------------------
// Bootstrapper implementation
// ---------------------------------------------------------------------------

/**
 * Create and run the boot sequence.
 *
 * Returns a BootHandle so callers can subscribe to lifecycle events
 * and await completion.
 */
export function createBootstrapper(config: BootstrapperConfig): BootHandle {
	const listeners = new Set<BootEventListener>();

	const emit = (event: BootEvent): void => {
		for (const listener of listeners) listener(event);
	};

	const done = runBootSequence(config, emit);

	return {
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		done,
	};
}

/**
 * The sequential boot spine. Each phase emits lifecycle events.
 *
 *   1. Boot TUI shell (immediate, shows splash)
 *   2. Pick session (inside TUI input area, or auto for headless)
 *   3. Resolve session (adapters, model, agent assembly)
 *   4. Wire session into TUI (subscribe, dispatch, submit)
 *   5. Await TUI stop (or headless process lifetime)
 */
async function runBootSequence(config: BootstrapperConfig, emit: (event: BootEvent) => void): Promise<void> {
	let shell: TuiShell | null = null;

	try {
		if (config.willUseTui) {
			shell = await config.createShell({ cwd: config.cwd });
			// Route lifecycle events to the TUI for progress rendering
			const originalEmit = emit;
			emit = (event: BootEvent): void => {
				originalEmit(event);
				shell?.handleBootEvent(event);
			};
		}

		emit({ phase: "session", status: "picking" });
		const selection = await config.pickSession(shell);
		emit({ phase: "session", status: "ready", sessionId: selection.store.id, isNew: selection.isNew });

		emit({ phase: "adapters", status: "loading" });
		const resolved = await config.resolveSession(selection);
		emit({
			phase: "adapters",
			status: "ready",
			adapterCount: 0,
			blueprintName: resolved.blueprintName ?? "",
		});
		emit({ phase: "model", status: "ready", modelId: resolved.modelId });

		emit({ phase: "agent", status: "wiring" });
		if (shell) {
			config.wireSession(shell, resolved, config.getDeps());
		}
		emit({ phase: "agent", status: "ready" });

		if (shell) {
			await shell.stopped;
		}
	} catch (err) {
		emit({ phase: "error", error: err instanceof Error ? err.message : String(err) });
		throw err;
	}
}
