/**
 * Boot phase types for the unified TUI lifecycle.
 *
 * The Bootstrapper starts the TUI immediately, then drives the boot spine
 * (storage -> session pick -> adapters -> agent) while emitting lifecycle
 * events that the TUI renders as progress.
 *
 * Phase flow:
 *   1. Shell   -- TUI layout visible, splash rendered, input area available
 *   2. Pick    -- session picker in input area (needs storage ready)
 *   3. Wiring  -- bootloader overlay with progress while agent assembles
 *   4. Live    -- agent wired, conversation input enabled, history loaded
 */

import type { Session } from "@dpopsuev/alef-session/contracts";
import type { SessionStore } from "@dpopsuev/alef-session/storage";
import type { SessionPreviewProvider, SessionStoreFactory } from "@dpopsuev/alef-storage";
import type { Editor, Terminal, ThemeTokens, TUI } from "@dpopsuev/alef-tui";
import type { ChatLog, FooterPanel, OutputPanel } from "@dpopsuev/alef-tui/views";
import type { BootEvent } from "../boot/bootstrapper.js";
import type { TuiChrome } from "./chrome.js";
import type { InputPanel } from "./panel.js";

// ---------------------------------------------------------------------------
// Shell phase -- TUI visible, no session yet
// ---------------------------------------------------------------------------

/** Minimal context needed to create the TUI shell before any services start. */
export interface TuiShellContext {
	cwd: string;
	terminal?: Terminal;
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
	store: SessionStore;
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
