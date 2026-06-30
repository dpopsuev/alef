import type { Session } from "@dpopsuev/alef-session/contracts";
import type { Component, TUI } from "@dpopsuev/alef-tui";
import type { ColorToken, ThemeTokens } from "./theme.js";

/** Tracks an in-flight tool call and its nested children in the TUI state. */
export interface ActiveCall {
	name: string;
	keyArg: string;
	parentCallId?: string;
	children: Map<string, ActiveCall>;
	depth: number;
	/** Markdown component for formatted output streaming (populated on first chunk) */
	outputMarkdown?: unknown; // Will be Markdown component from TUI
}

/** Descriptor for a modal overlay component mounted over the main TUI. */
export interface OverlayDescriptor {
	id: string;
	component: Component;
	handleInput?(data: string): void;
}

/** Handle for updating the token usage footer text after a turn completes. */
export interface TokenFooterHandle {
	setText(text: string): void;
}

/** State of an async background task launched via agent.run. */
export interface BackgroundTask {
	taskId: string;
	profile: string;
	status: "running" | "completed" | "failed";
	startedAt: number;
	completedAt?: number;
	chunks: string[];
	reply?: string;
	error?: string;
}

/** Immutable snapshot of the TUI's runtime state — active calls, overlays, token usage. */
export interface TuiState {
	activeCalls: Map<string, ActiveCall>;
	/** null means no tool batch is in progress. */
	batchStartedAt: number | null;
	turnStartedAt: number;
	pendingFooterShown: boolean;
	sessionTokensTotal: number;
	sessionInputTokens: number;
	sessionOutputTokens: number;
	sessionCostUsd: number;
	contextFillTokens: number;
	compacted: boolean;
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
	/** Accumulated subagent reply text per parent callId. */
	innerReplies: Map<string, string>;
	/** Background tasks launched via agent.run(async: true). */
	backgroundTasks: Map<string, BackgroundTask>;
}

/** Create a fresh TuiState with all counters zeroed and collections empty. */
export function initialTuiState(): TuiState {
	return {
		activeCalls: new Map(),
		batchStartedAt: null,
		turnStartedAt: 0,
		pendingFooterShown: false,
		sessionTokensTotal: 0,
		sessionInputTokens: 0,
		sessionOutputTokens: 0,
		sessionCostUsd: 0,
		contextFillTokens: 0,
		compacted: false,
		pendingTokenFooter: null,
		abortCurrentTurn: undefined,
		overlays: [],
		callChunks: new Map(),
		focusedCallId: null,
		inspectorScrollOffset: 0,
		validationErrors: new Map(),
		exitCodes: new Map(),
		innerReplies: new Map(),
		backgroundTasks: new Map(),
	};
}

/** Diff previous and next overlay lists, adding/removing components from the TUI tree. */
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
/** Structural interface for the chat log writer, enabling mock injection in tests. */
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
	addSubagentReply(name: string, reply: string): void;
	addTokenFooter(): TokenFooterHandle;
	addUserMessage(text: string): void;
}

/** Structural interface for the streaming reply block component. */
export interface TuiReplyBlock {
	reset(): void;
	clear(): void;
	hideThinking: boolean;
	setHideThinking(hide: boolean): void;
}

/** Structural interface for a typewriter that accumulates streaming text chunks. */
export interface TuiTypewriter {
	receive(text: string): void;
	flush(): void;
	reset(): void;
}

/** Structural interface for the prompt console, enabling mock injection in tests. */
export interface TuiPromptConsole {
	pulse(): void;
	showPendingFooter(fg: ColorToken): void;
	hidePendingFooter(): void;
	showInFlightCall(callId: string, name: string, keyArg: string): void;
	removeInFlightCall(callId: string): void;
	updateInFlightCallChunk(callId: string, text: string): void;
	startThinking(): void;
	stopThinking(): void;
	setIntent(text: string): void;
	setStatus(text: string): void;
	setWidgetAbove(text: string): void;
	readonly isThinking: boolean;
	readonly widgetSlotAbove: { addChild(c: unknown): void; removeChild(c: unknown): void };
	readonly widgetSlotBelow: { addChild(c: unknown): void; removeChild(c: unknown): void };
	setFocusedCall(callId: string | null): void;
	setChunkText(text: string): void;
	setCallIdentity(callId: string, colorName: string, address: string, modelId?: string): void;
	updateCallTokens(callId: string, input: number, output: number): void;
	addChildCall(parentCallId: string, callId: string, name: string, keyArg: string, depth: number): void;
	removeChildCall(parentCallId: string, callId: string): void;
	showToast(message: string, durationMs?: number): void;
	showBackgroundTask(taskId: string, profile: string): void;
	updateBackgroundTask(taskId: string, status: "completed" | "failed", detail?: string): void;
	buildFlowLayout(): unknown | null;
	showCancellableLoader(message: string, onAbort: () => void): unknown;
	removeCancellableLoader(loader: unknown): void;
}

/** Composite of all UI components needed by the TUI event dispatcher. */
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
