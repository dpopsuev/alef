import type { InteractiveOptions } from "../interactive.js";
import type { Session } from "../session.js";
import type { ThemeTokens } from "../theme.js";
import type { ChatLog } from "../tui/chat-log.js";

export interface TuiHandlerContext {
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
	abortCurrentTurn: (() => void) | undefined;
	setAbortCurrentTurn(fn: (() => void) | undefined): void;
}
