import type { TuiStateStore } from "@dpopsuev/alef-tui/views";
import type { SessionStore } from "@dpopsuev/alef-session";
import type { TUI } from "@dpopsuev/alef-tui";
import type { InteractiveOptions } from "./interactive.js";
import type { Session } from "./session.js";
import type { ThemeTokens } from "./theme.js";
import type { ChatLog } from "@dpopsuev/alef-tui/views";
import type { TuiHandlerContext } from "./tui-commands.js";
import type { TuiEvent } from "./tui-dispatch.js";
import type { TuiState } from "./tui-state.js";

export function createContextFactory(
	t: ThemeTokens,
	writer: ChatLog,
	tui: TUI,
	opts: InteractiveOptions,
	session: Session,
	getState: () => TuiState,
	dispatch: (event: TuiEvent) => void,
	store?: SessionStore,
	tuiStore?: TuiStateStore,
): () => TuiHandlerContext {
	return () => ({
		t,
		writer,
		tui,
		opts,
		session,
		store,
		tuiStore,
		dispatch,
		abortCurrentTurn: getState().abortCurrentTurn,
		setAbortCurrentTurn: (fn: (() => void) | undefined) =>
			fn ? dispatch({ type: "abort.set", fn }) : dispatch({ type: "abort.clear" }),
	});
}
