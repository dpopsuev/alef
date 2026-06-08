import type { Component, TUI } from "@dpopsuev/alef-tui";
import type { Session } from "./session.js";
import type { ColorToken, ThemeTokens } from "./theme.js";

export interface ActiveCall {
	name: string;
	keyArg: string;
}

export interface OverlayDescriptor {
	id: string;
	component: Component;
	handleInput?(data: string): void;
}

export interface TuiState {
	activeCalls: Map<string, ActiveCall>;
	batchStartedAt: number;
	turnStartedAt: number;
	pendingFooterShown: boolean;
	sessionTokensTotal: number;
	pendingTokenFooter: { setText(s: string): void } | null;
	abortCurrentTurn: (() => void) | undefined;
	overlays: readonly OverlayDescriptor[];
}

export function initialTuiState(): TuiState {
	return {
		activeCalls: new Map(),
		batchStartedAt: 0,
		turnStartedAt: 0,
		pendingFooterShown: false,
		sessionTokensTotal: 0,
		pendingTokenFooter: null,
		abortCurrentTurn: undefined,
		overlays: [],
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
	addCompletedToolBlock(name: string, keyArg: string, elapsedMs: number, ok: boolean, output: unknown): void;
	addBatchTiming(elapsedMs: number): void;
	addNotice(text: string): void;
	addTokenFooter(): { setText(s: string): void };
	addUserMessage(text: string): void;
}

export interface TuiStreamingZone {
	reset(): void;
	clear(): void;
}

export interface TuiTypewriter {
	receive(text: string): void;
	flush(): void;
	reset(): void;
}

export interface TuiConsoleZone {
	pulse(): void;
	showPendingFooter(fg: ColorToken): void;
	hidePendingFooter(): void;
	showInFlightCall(callId: string, name: string, keyArg: string): void;
	removeInFlightCall(callId: string): void;
	updateInFlightCallChunk(callId: string, text: string): void;
	startThinking(): void;
	stopThinking(): void;
	readonly isThinking: boolean;
}

export interface TuiUi {
	writer: TuiWriter;
	streamingZone: TuiStreamingZone;
	replyTW: TuiTypewriter;
	thinkingTW: TuiTypewriter;
	consoleZone: TuiConsoleZone;
	tui: Pick<TUI, "requestRender">;
	t: ThemeTokens;
	session: Pick<Session, "state">;
}
