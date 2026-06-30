import type { Session } from "@dpopsuev/alef-session/contracts";
import type { SessionStore } from "@dpopsuev/alef-session/storage";
import type { ChatLog, TuiStateStore } from "@dpopsuev/alef-tui/views";
import type { InteractiveOptions } from "../../boot/interactive.js";
import type { TuiEvent } from "../events.js";
import type { ThemeTokens } from "../theme.js";

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
