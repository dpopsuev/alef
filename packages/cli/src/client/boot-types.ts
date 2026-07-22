/**
 * Boot phase types for the unified TUI lifecycle.
 *
 * These interfaces define the contract between the TUI layer (client/)
 * and the Bootstrapper/Supervisor layer (boot/). Runtime dependencies
 * flow through injection -- the TUI never imports boot/ modules directly.
 *
 * Phase flow:
 *   1. Shell   -- TUI layout visible, splash rendered, input area available
 *   2. Pick    -- session picker in input area (needs storage ready)
 *   3. Wiring  -- bootloader overlay with progress while agent assembles
 *   4. Live    -- agent wired, conversation input enabled, history loaded
 */

import type { ActorRouteTable } from "@dpopsuev/alef-agent/identity/routes";
import type { UiSignalHandler } from "@dpopsuev/alef-kernel/adapter";
import type { DiscussionRef } from "@dpopsuev/alef-kernel/execution";
import type { Session } from "@dpopsuev/alef-session/contracts";
import type { SessionStore } from "@dpopsuev/alef-session/storage";
import type { SessionPreviewProvider, SessionStoreFactory } from "@dpopsuev/alef-storage";
import type { Editor, Terminal, ThemeTokens, TUI } from "@dpopsuev/alef-tui";
import type { ChatLog, FooterPanel, OutputPanel, TuiStateStore } from "@dpopsuev/alef-tui/views";
import type { AlefConfig } from "../boot/config.js";
import type { TuiChrome } from "./chrome.js";
import type { InputPanel } from "./panel.js";

// ---------------------------------------------------------------------------
// InteractiveOptions -- shared between TUI and non-TUI view modes
// ---------------------------------------------------------------------------

/** Configuration for interactive dialog modes (TUI, readline, JSON stream). */
export interface InteractiveOptions {
	cwd: string;
	modelId: string;
	sessionId: string;
	contextWindow?: number;
	getModel?: () => string;
	setModel?: (id: string) => void;
	getThinking?: () => string;
	setThinking?: (level: string) => void;
	humanAddress?: string;
	agentAddress?: string;
	actorRoutes?: ActorRouteTable;
	blueprintName?: string;
	discussion?: DiscussionRef;
	summarize?: (
		messages: readonly unknown[],
		opts?: { instructions?: string; priorSummary?: string },
	) => Promise<string> | string;
}

// ---------------------------------------------------------------------------
// BuildInfo -- compile-time metadata injected from boot layer
// ---------------------------------------------------------------------------

/** Compile-time metadata passed down from the boot layer. */
export interface BuildInfo {
	version: string;
	gitHash: string;
	gitBranch: string;
	gitCommitTimestamp: string;
	buildTimestamp: string;
	channel: string;
}

// ---------------------------------------------------------------------------
// Boot lifecycle events -- shared contract between Bootstrapper and TUI
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

// ---------------------------------------------------------------------------
// Shell phase -- TUI visible, no session yet
// ---------------------------------------------------------------------------

/** Minimal context needed to create the TUI shell before any services start. */
export interface TuiShellContext {
	cwd: string;
	terminal?: Terminal;
	buildInfo?: BuildInfo;
}

/**
 * Running TUI shell -- layout is up, input area accepts pickers.
 *
 * Created by `bootTuiShell()` before a session exists.
 * The Bootstrapper feeds lifecycle events into it; after session selection
 * and agent wiring, the shell transitions to conversation mode.
 */
export interface TuiShell {
	readonly tui: TUI;
	readonly t: ThemeTokens;
	readonly output: OutputPanel;
	readonly input: InputPanel;
	readonly footer: FooterPanel;
	readonly writer: ChatLog;
	readonly editor: Editor;
	readonly chrome: TuiChrome;
	readonly tuiStore: TuiStateStore;
	readonly cwd: string;

	/** Render a boot lifecycle event as progress in the TUI. */
	handleBootEvent(event: BootEvent): void;

	/** Await TUI stop (user quit). */
	readonly stopped: Promise<void>;
}

// ---------------------------------------------------------------------------
// Session selection
// ---------------------------------------------------------------------------

/** Result of the session picker running inside the TUI input area. */
export interface SessionSelection {
	store: SessionStore;
	isNew: boolean;
}

/** Dependencies for the in-TUI session picker. */
export interface SessionPickerDeps {
	cwd: string;
	sessions: SessionStoreFactory;
	preview?: SessionPreviewProvider;
}

// ---------------------------------------------------------------------------
// Session wiring -- connects a resolved session to the TUI
// ---------------------------------------------------------------------------

/** Everything the TUI needs to enter conversation mode. */
export interface ResolvedSession {
	session: Session;
	store?: SessionStore;
	sessionId: string;
	modelId: string;
	contextWindow: number;
	isNew: boolean;
	getModel: () => string;
	setModel: (id: string) => void;
	getThinking: () => string;
	setThinking: (level: string) => void;
	humanAddress: string;
	agentAddress: string;
	blueprintName?: string;
}

/**
 * Resolve a session selection into a fully wired agent session.
 *
 * Called by the Bootstrapper after the user picks/creates a session in the
 * TUI. Handles adapter loading, model resolution, agent assembly --
 * everything between session selection and conversation mode.
 */
export type SessionResolver = (selection: SessionSelection) => Promise<ResolvedSession>;

// ---------------------------------------------------------------------------
// Injected dependencies -- services the TUI receives, never imports
// ---------------------------------------------------------------------------

/** Port for triggering a warm reboot (build + restart). */
export interface RebootPort {
	reboot(): Promise<void>;
}

/** Strategy for full process restart. */
export interface RestartStrategy {
	restart(): Promise<never>;
}

/** Execution primitives for scoped restart after :update. */
export interface RestartExecutor {
	exit(): Promise<never>;
	restartTui(): Promise<void>;
	restartSupervisor(): Promise<void>;
	reloadAdapters(names: string[]): Promise<void>;
}

/**
 * Dependencies injected into wireSession by the Bootstrapper.
 * These replace the module-level singleton imports that previously
 * coupled the TUI directly to the boot layer.
 */
export interface WireSessionDeps {
	/** UI signal handlers contributed by adapters. */
	signalHandlers: ReadonlyMap<string, UiSignalHandler>;
	/** Whether the context window has been compacted this session. */
	isCompacted: () => boolean;
	/** Port for triggering warm reboot. */
	rebootPort?: RebootPort;
	/** Strategy for full process restart. */
	restartStrategy?: RestartStrategy;
	/** Check for newer version (async, best-effort). */
	checkForUpdate: () => Promise<string | null>;
	/** Tear down and rebuild the TUI while keeping the supervisor alive. */
	restartTui?: () => Promise<void>;
	/** Hot-reload adapters by name (unload + reload). */
	reloadAdapters?: (names: string[]) => Promise<void>;
	/** Drain and restart the supervisor service graph. */
	restartSupervisor?: () => Promise<void>;
	/** Build metadata injected from boot layer. */
	buildInfo?: BuildInfo;
	/** Return the current AlefConfig (re-reads on each call). */
	getConfig: () => AlefConfig;
}
