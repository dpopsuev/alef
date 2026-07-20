/**
 * Boot phase types for the unified TUI lifecycle.
 *
 * The TUI boots immediately with minimal context (cwd, theme). Session and
 * blueprint selection happen as interactive steps inside the input area.
 * Once resolved, the TUI transitions to conversation mode.
 *
 * Phase flow:
 *   1. Shell   -- TUI layout visible, input area available for pickers
 *   2. Wiring  -- session selected, agent assembled, subscribe/dispatch connected
 *   3. Live    -- normal conversation input enabled, history loaded
 */

import type { Session } from "@dpopsuev/alef-session/contracts";
import type { SessionStore } from "@dpopsuev/alef-session/storage";
import type { SessionPreviewProvider, SessionStoreFactory } from "@dpopsuev/alef-storage";
import type { Editor, Terminal, ThemeTokens, TUI } from "@dpopsuev/alef-tui";
import type { ChatLog, OutputPanel } from "@dpopsuev/alef-tui/views";
import type { TuiChrome } from "./chrome.js";
import type { InputPanel } from "./panel.js";

// ---------------------------------------------------------------------------
// Shell phase -- TUI visible, no session yet
// ---------------------------------------------------------------------------

/** Minimal context available before session selection. */
export interface TuiShellContext {
	cwd: string;
	terminal?: Terminal;
}

/**
 * Running TUI shell -- layout is up, input area accepts pickers.
 * Returned by bootTuiShell(); the caller wires a session into it.
 */
export interface TuiShell {
	readonly tui: TUI;
	readonly t: ThemeTokens;
	readonly output: OutputPanel;
	readonly input: InputPanel;
	readonly writer: ChatLog;
	readonly editor: Editor;
	readonly chrome: TuiChrome;
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
 * Called after the user picks/creates a session in the TUI. Handles adapter
 * loading, model resolution, agent assembly -- everything between
 * loadSession() and the current runAgent() entry point.
 */
export type SessionResolver = (selection: SessionSelection) => Promise<ResolvedSession>;
