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

// ---------------------------------------------------------------------------
// Lifecycle events -- one-shot, ordered boot progress
// ---------------------------------------------------------------------------

/** Discriminated union of boot lifecycle events emitted by the Bootstrapper. */
export type BootEvent =
	| { phase: "storage"; status: "starting" }
	| { phase: "storage"; status: "ready" }
	| { phase: "session"; status: "picking" }
	| { phase: "session"; status: "ready"; sessionId: string; isNew: boolean }
	| { phase: "adapters"; status: "loading" }
	| { phase: "adapters"; status: "ready"; adapterCount: number; blueprintName: string }
	| { phase: "model"; status: "ready"; modelId: string }
	| { phase: "agent"; status: "wiring" }
	| { phase: "agent"; status: "ready" }
	| { phase: "error"; error: string };

/** Callback that receives boot lifecycle events for progress display. */
export type BootEventListener = (event: BootEvent) => void;

// ---------------------------------------------------------------------------
// Bootstrapper interface
// ---------------------------------------------------------------------------

/** Dependencies injected into the Bootstrapper at construction. */
export interface BootstrapperDeps {
	/** Parsed CLI args. */
	args: BootstrapperArgs;
	/** Loaded config. */
	cfg: unknown;
	/** Working directory. */
	cwd: string;
	/** Whether TUI should be used (TTY + no --print/--json/--no-tui). */
	willUseTui: boolean;
}

/** Subset of CLI args the Bootstrapper needs. */
export interface BootstrapperArgs {
	cwd: string;
	debug: boolean;
	print: string;
	json: boolean;
	noTui: boolean;
	modelId?: string;
	resume?: string;
	blueprint?: string;
	serve?: number;
	daemon?: boolean;
	host?: string;
}

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
