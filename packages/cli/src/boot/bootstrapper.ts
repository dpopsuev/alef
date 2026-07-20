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

// Re-export BootEvent from the shared contract so both layers use one source
export type { BootEvent } from "../client/boot-types.js";

import type { BootEvent } from "../client/boot-types.js";

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
// Bootstrapper interface
// ---------------------------------------------------------------------------

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
