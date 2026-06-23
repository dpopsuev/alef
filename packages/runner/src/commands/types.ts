import type { SessionStore } from "@dpopsuev/alef-session";
import type { ChatLog, TuiStateStore } from "@dpopsuev/alef-tui/views";
import type { InteractiveOptions } from "../interactive.js";
import type { Session } from "../session.js";
import type { ThemeTokens } from "../theme.js";
import type { TuiEvent } from "../tui-dispatch.js";

export interface TuiHandlerContext {
	tuiStore?: TuiStateStore;
	t: ThemeTokens;
	writer: ChatLog;
	opts?: InteractiveOptions;
	tui: {
		stop(): void;
		removeChild(c: unknown): void;
		addChild(c: unknown): void;
		requestRender(force?: boolean): void;
	};
	session: Session;
	store?: SessionStore;
	dispatch: (event: TuiEvent) => void;
	abortCurrentTurn: (() => void) | undefined;
	setAbortCurrentTurn(fn: (() => void) | undefined): void;
}
