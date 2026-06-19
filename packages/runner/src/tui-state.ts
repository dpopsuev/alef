import type { Component, TUI } from "@dpopsuev/alef-tui";
import type { Session } from "./session.js";
import type { ColorToken, ThemeTokens } from "./theme.js";

export interface ActiveCall {
	name: string;
	keyArg: string;
	parentCallId?: string;
	children: Map<string, ActiveCall>;
	depth: number;
}

export interface OverlayDescriptor {
	id: string;
	component: Component;
	handleInput?(data: string): void;
}

export interface TokenFooterHandle {
	setText(text: string): void;
}

export interface TuiState {
	activeCalls: Map<string, ActiveCall>;
	/** null means no tool batch is in progress. */
	batchStartedAt: number | null;
	turnStartedAt: number;
	pendingFooterShown: boolean;
	sessionTokensTotal: number;
	pendingTokenFooter: TokenFooterHandle | null;
	abortCurrentTurn: (() => void) | undefined;
	overlays: readonly OverlayDescriptor[];
	/** Per-call streaming chunks for the subagent inspector. */
	callChunks: Map<string, string[]>;
	/** Currently focused call in the inspector (null = no focus). */
	focusedCallId: string | null;
	/** Scroll offset for the inspector chunk detail (lines from end). */
	inspectorScrollOffset: number;
	/** Validation errors and warnings per tool call (callId → messages). */
	validationErrors: Map<string, string[]>;
	/** Exit codes from shell/exec tools (callId → exit code). */
	exitCodes: Map<string, number>;
}

export function initialTuiState(): TuiState {
	return {
		activeCalls: new Map(),
		batchStartedAt: null,
		turnStartedAt: 0,
		pendingFooterShown: false,
		sessionTokensTotal: 0,
		pendingTokenFooter: null,
		abortCurrentTurn: undefined,
		overlays: [],
		callChunks: new Map(),
		focusedCallId: null,
		inspectorScrollOffset: 0,
		validationErrors: new Map(),
		exitCodes: new Map(),
	};
}

export function syncOverlays(
	tui: Pick<TUI, "addChild" | "removeChild">,
	prev: readonly OverlayDescriptor[],
	next: readonly OverlayDescriptor[],
): void {
	const prevIds = new Set(prev.map((o) => o.id));
	const nextIds = new Set(next.map((o) => o.id));
	for (const o of prev) if (!nextIds.has(o.id)) tui.removeChild(o.component);
	for (const o of next) if (!prevIds.has(o.id)) tui.addChild(o.component);
}

// Structural interfaces — allow unit tests to inject mocks without concrete classes.
export interface TuiWriter {
	addCompletedToolBlock(
		name: string,
		keyArg: string,
		elapsedMs: number,
		ok: boolean,
		display: string | null,
		displayKind: string | null,
	): void;
	addBatchTiming(elapsedMs: number): void;
	addNotice(text: string): void;
	addTokenFooter(): TokenFooterHandle;
	addUserMessage(text: string): void;
}

export interface TuiReplyBlock {
	reset(): void;
	clear(): void;
	hideThinking: boolean;
	setHideThinking(hide: boolean): void;
}

export interface TuiTypewriter {
	receive(text: string): void;
	flush(): void;
	reset(): void;
}

export interface TuiPromptConsole {
	pulse(): void;
	showPendingFooter(fg: ColorToken): void;
	hidePendingFooter(): void;
	showInFlightCall(callId: string, name: string, keyArg: string): void;
	removeInFlightCall(callId: string): void;
	updateInFlightCallChunk(callId: string, text: string): void;
	startThinking(): void;
	stopThinking(): void;
	readonly isThinking: boolean;
	setFocusedCall(callId: string | null): void;
	setChunkText(text: string): void;
	setCallIdentity(callId: string, colorName: string, address: string): void;
	addChildCall(parentCallId: string, callId: string, name: string, keyArg: string, depth: number): void;
	removeChildCall(parentCallId: string, callId: string): void;
}

export interface TuiUi {
	writer: TuiWriter;
	replyBlock: TuiReplyBlock;
	replyTW: TuiTypewriter;
	thinkingTW: TuiTypewriter;
	promptConsole: TuiPromptConsole;
	tui: Pick<TUI, "requestRender">;
	t: ThemeTokens;
	session: Pick<Session, "state" | "cancelToolCall">;
}
