import type { TUI } from "@dpopsuev/alef-tui";
import type { InteractiveOptions } from "./interactive.js";
import type { Session } from "./session.js";
import type { ThemeTokens } from "./theme.js";
import type { ChatLog } from "./tui/chat-log.js";
import type { TuiHandlerContext } from "./tui-commands.js";
import type { TuiEvent } from "./tui-dispatch.js";
import type { TuiState } from "./tui-state.js";

/**
 * Create a TUI handler context factory.
 * Returns a function that creates a fresh context on each call.
 */
export function createContextFactory(
	t: ThemeTokens,
	writer: ChatLog,
	tui: TUI,
	opts: InteractiveOptions,
	session: Session,
	getState: () => TuiState,
	dispatch: (event: TuiEvent) => void,
): () => TuiHandlerContext {
	return () => ({
		t,
		writer,
		tui,
		opts,
		session,
		dispatch,
		abortCurrentTurn: getState().abortCurrentTurn,
		setAbortCurrentTurn: (fn: (() => void) | undefined) =>
			fn ? dispatch({ type: "abort.set", fn }) : dispatch({ type: "abort.clear" }),
	});
}
