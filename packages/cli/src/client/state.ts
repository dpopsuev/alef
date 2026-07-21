import type { WorkContext } from "@dpopsuev/alef-kernel/execution";
import type { Session } from "@dpopsuev/alef-session/contracts";
import type { Component, TUI } from "@dpopsuev/alef-tui";
import type { ColorToken, ThemeTokens } from "./theme.js";

/** Tracks an in-flight tool call and its nested children in the TUI state. */
export interface ActiveCall {
	name: string;
	keyArg: string;
	args: Record<string, unknown>;
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

/** Durable async task ledger entry derived from task lifecycle events. */
export interface TaskLedgerEntry {
	taskId: string;
	profile: string;
	status: "running" | "completed" | "failed" | "cancelled";
	startedAt: number;
	lastActivityAt: number;
	completedAt?: number;
	ownerAddress?: string;
	modelId?: string;
	planId?: string;
	stepId?: string;
	discourseTopic?: string;
	discourseThread?: string;
	work?: WorkContext;
	attempt?: number;
	chunkTail: string[];
	reply?: string;
	error?: string;
}

/** Immutable snapshot of the TUI's runtime state — active calls, overlays, token usage. */
export interface DispatchState {
	activeCalls: Map<string, ActiveCall>;
	/** null means no tool batch is in progress. */
	batchStartedAt: number | null;
	/** Tools started in the current batch (for multi-tool batch timing). */
	batchCallCount: number;
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
	/** Durable async task ledger launched via agent.run(async: true). */
	taskLedger: Map<string, TaskLedgerEntry>;
}

/** Create a fresh DispatchState with all counters zeroed and collections empty. */
export function initialDispatchState(): DispatchState {
	return {
		activeCalls: new Map(),
		batchStartedAt: null,
		batchCallCount: 0,
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
		taskLedger: new Map(),
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
export interface ChatWriter {
	addCompletedToolBlock(
		name: string,
		keyArg: string,
		args: Record<string, unknown>,
		elapsedMs: number,
		ok: boolean,
		display: string | null,
		displayKind: string | null,
	): void;
	addAgentReply(text: string): void;
	addBatchTiming(elapsedMs: number): void;
	addNotice(text: string): void;
	addSubagentReply(name: string, reply: string): void;
	addTokenFooter(): TokenFooterHandle;
	addUserMessage(text: string): void;
	clearAll(): void;
}

/** Structural interface for the streaming reply block component. */
export interface ReplyBlockPort {
	reset(): void;
	clear(): void;
	hideThinking: boolean;
	setHideThinking(hide: boolean): void;
}

/** Structural interface for a typewriter that accumulates streaming text chunks. */
export interface TypewriterPort {
	receive(text: string): void;
	flush(): void;
	reset(): void;
}

/** Structural interface for the prompt console, enabling mock injection in tests. */
export interface DockConsolePort {
	pulse(): void;
	showPendingFooter(fg: ColorToken): void;
	hidePendingFooter(): void;
	showInFlightCall(callId: string, name: string, keyArg: string, args: Record<string, unknown>): void;
	removeInFlightCall(callId: string): void;
	updateInFlightCallChunk(callId: string, text: string): void;
	startThinking(): void;
	stopThinking(): void;
	setIntent(text: string): void;
	setTopicLabel(text: string): void;
	setStatus(text: string, clearAfterTurns?: number): void;
	setNotice(text: string, clearAfterTurns?: number): void;
	setWidgetAbove(text: string): void;
	onTurnComplete(): void;
	readonly isThinking: boolean;
	readonly widgetSlotAbove: { addChild(c: unknown): void; removeChild(c: unknown): void };
	readonly widgetSlotBelow: { addChild(c: unknown): void; removeChild(c: unknown): void };
	setFocusedCall(callId: string | null): void;
	setChunkText(text: string): void;
	setCallIdentity(callId: string, colorName: string, address: string, modelId?: string): void;
	updateCallTokens(callId: string, input: number, output: number): void;
	addChildCall(
		parentCallId: string,
		callId: string,
		name: string,
		keyArg: string,
		args: Record<string, unknown>,
		depth: number,
	): void;
	removeChildCall(parentCallId: string, callId: string): void;
	showToast(message: string, durationMs?: number): void;
	showBackgroundTask(taskId: string, profile: string): void;
	updateBackgroundTask(taskId: string, status: "completed" | "failed", detail?: string): void;
	/** Returns texts drained from the panel head — caller should add them to scrollback. */
	syncPendingQueue(opts: { queueLength: number; text?: string; mode?: "steer" | "followUp" | "nextTurn" }): string[];
}

/** Composite of all UI components needed by the TUI event dispatcher. */
export interface DispatchPorts {
	writer: ChatWriter;
	replyBlock: ReplyBlockPort;
	replyTW: TypewriterPort;
	thinkingTW: TypewriterPort;
	promptConsole: DockConsolePort;
	tui: Pick<TUI, "requestRender">;
	t: ThemeTokens;
	session: Pick<Session, "state" | "cancelToolCall" | "receive" | "send" | "getDiscussion" | "setDiscussion">;
}
