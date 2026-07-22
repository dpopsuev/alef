/**
 * RenderIntent -- declarative rendering commands produced by the pure
 * event dispatch function.
 *
 * Each intent maps to one imperative mutation on DispatchPorts components.
 * The dispatch function produces DispatchState + RenderIntent[]; the apply
 * function executes them against the concrete UI surface.
 *
 * This separation enables:
 *   - Pure-function testing of event dispatch (no terminal needed)
 *   - Alternative UI surfaces (web) consuming the same intent stream
 *   - Headless test harnesses collecting intents as assertions
 */

import type { ColorToken } from "@dpopsuev/alef-tui";

// ---------------------------------------------------------------------------
// Writer intents -- ChatLog mutations
// ---------------------------------------------------------------------------

/** Append a completed tool call block to the chat log. */
export interface AppendToolResult {
	readonly kind: "append-tool-result";
	readonly name: string;
	readonly keyArg: string;
	readonly args: Record<string, unknown>;
	readonly elapsedMs: number;
	readonly ok: boolean;
	readonly display: string | null;
	readonly displayKind: string | null;
}

/** Append a subagent reply to the chat log. */
export interface AppendSubagentReply {
	readonly kind: "append-subagent-reply";
	readonly name: string;
	readonly reply: string;
}

/** Append batch timing line to the chat log. */
export interface AppendBatchTiming {
	readonly kind: "append-batch-timing";
	readonly elapsedMs: number;
}

/** Append a notice to the chat log. */
export interface AppendNotice {
	readonly kind: "append-notice";
	readonly text: string;
}

/** Append a user message to the chat log. */
export interface AppendUserMessage {
	readonly kind: "append-user-message";
	readonly text: string;
}

// ---------------------------------------------------------------------------
// Reply block intents -- streaming reply area
// ---------------------------------------------------------------------------

/** Reset the reply block between turns. */
export interface ResetReplyBlock {
	readonly kind: "reset-reply-block";
}

/** Clear the reply block content. */
export interface ClearReplyBlock {
	readonly kind: "clear-reply-block";
}

/** Toggle thinking visibility in the reply block. */
export interface SetHideThinking {
	readonly kind: "set-hide-thinking";
	readonly hide: boolean;
}

// ---------------------------------------------------------------------------
// Typewriter intents -- streaming text chunks
// ---------------------------------------------------------------------------

/** Send a text chunk to the reply typewriter. */
export interface ReplyChunk {
	readonly kind: "reply-chunk";
	readonly text: string;
}

/** Send a text chunk to the thinking typewriter. */
export interface ThinkingChunk {
	readonly kind: "thinking-chunk";
	readonly text: string;
}

/** Flush the reply typewriter. */
export interface FlushReplyTW {
	readonly kind: "flush-reply-tw";
}

/** Flush the thinking typewriter. */
export interface FlushThinkingTW {
	readonly kind: "flush-thinking-tw";
}

/** Reset the reply typewriter. */
export interface ResetReplyTW {
	readonly kind: "reset-reply-tw";
}

/** Reset the thinking typewriter. */
export interface ResetThinkingTW {
	readonly kind: "reset-thinking-tw";
}

// ---------------------------------------------------------------------------
// Prompt console intents -- status, in-flight cards, inspector
// ---------------------------------------------------------------------------

/** Pulse the prompt console spinner. */
export interface Pulse {
	readonly kind: "pulse";
}

/** Show the pending footer with accent color. */
export interface ShowPendingFooter {
	readonly kind: "show-pending-footer";
	readonly fg: ColorToken;
}

/** Hide the pending footer. */
export interface HidePendingFooter {
	readonly kind: "hide-pending-footer";
}

/** Show an in-flight tool call card. */
export interface ShowInFlightCall {
	readonly kind: "show-in-flight-call";
	readonly callId: string;
	readonly name: string;
	readonly keyArg: string;
	readonly args: Record<string, unknown>;
}

/** Remove an in-flight tool call card. */
export interface RemoveInFlightCall {
	readonly kind: "remove-in-flight-call";
	readonly callId: string;
}

/** Update the chunk text on an in-flight tool call card. */
export interface UpdateInFlightCallChunk {
	readonly kind: "update-in-flight-call-chunk";
	readonly callId: string;
	readonly text: string;
}

/** Start the thinking indicator. */
export interface StartThinking {
	readonly kind: "start-thinking";
}

/** Stop the thinking indicator. */
export interface StopThinking {
	readonly kind: "stop-thinking";
}

/** Set the intent text. */
export interface SetIntent {
	readonly kind: "set-intent";
	readonly text: string;
}

/** Set the topic label. */
export interface SetTopicLabel {
	readonly kind: "set-topic-label";
	readonly text: string;
}

/** Set the status text. */
export interface SetStatus {
	readonly kind: "set-status";
	readonly text: string;
	readonly clearAfterTurns?: number;
}

/** Set a notice in the prompt console. */
export interface SetConsoleNotice {
	readonly kind: "set-console-notice";
	readonly text: string;
	readonly clearAfterTurns?: number;
}

/** Set the widget text above the editor. */
export interface SetWidgetAbove {
	readonly kind: "set-widget-above";
	readonly text: string;
}

/** Signal turn completion to the prompt console. */
export interface OnTurnComplete {
	readonly kind: "on-turn-complete";
}

/** Set the focused call in the inspector. */
export interface SetFocusedCall {
	readonly kind: "set-focused-call";
	readonly callId: string | null;
}

/** Set the chunk text in the inspector detail view. */
export interface SetChunkText {
	readonly kind: "set-chunk-text";
	readonly text: string;
}

/** Set the identity (color, address) of an in-flight call. */
export interface SetCallIdentity {
	readonly kind: "set-call-identity";
	readonly callId: string;
	readonly colorName: string;
	readonly address: string;
	readonly modelId?: string;
}

/** Update token counters on an in-flight call card. */
export interface UpdateCallTokens {
	readonly kind: "update-call-tokens";
	readonly callId: string;
	readonly input: number;
	readonly output: number;
}

/** Add a nested child call to a parent in-flight card. */
export interface AddChildCall {
	readonly kind: "add-child-call";
	readonly parentCallId: string;
	readonly callId: string;
	readonly name: string;
	readonly keyArg: string;
	readonly args: Record<string, unknown>;
	readonly depth: number;
}

/** Remove a nested child call from a parent in-flight card. */
export interface RemoveChildCall {
	readonly kind: "remove-child-call";
	readonly parentCallId: string;
	readonly callId: string;
}

/** Show a toast notification. */
export interface ShowToast {
	readonly kind: "show-toast";
	readonly message: string;
	readonly durationMs?: number;
}

/** Show a background task in the task panel. */
export interface ShowBackgroundTask {
	readonly kind: "show-background-task";
	readonly taskId: string;
	readonly profile: string;
}

/** Update a background task status. */
export interface UpdateBackgroundTask {
	readonly kind: "update-background-task";
	readonly taskId: string;
	readonly status: "completed" | "failed";
	readonly detail?: string;
}

/** Sync the pending message queue. */
export interface SyncPendingQueue {
	readonly kind: "sync-pending-queue";
	readonly queueLength: number;
	readonly text?: string;
	readonly mode?: "steer" | "followUp" | "nextTurn";
}

/** Set the text on a pending token-usage footer handle. */
export interface SetTokenFooterText {
	readonly kind: "set-token-footer-text";
	readonly text: string;
}

/** Cancel a currently focused tool call via the session. */
export interface CancelToolCall {
	readonly kind: "cancel-tool-call";
	readonly callId: string;
	readonly name: string;
}

/** Tick the thinking animation — updates card spinners or standalone spinner. */
export interface ThinkingTick {
	readonly kind: "thinking-tick";
}

/** Handle an expired toast — removes it from the widget slot. */
export interface ToastExpired {
	readonly kind: "toast-expired";
}

/** Tick the thinking animation — update spinner or card elapsed times. */
export interface ThinkingTick {
	readonly kind: "thinking-tick";
}

/** Handle an expired toast — remove it from the widget slot. */
export interface ToastExpired {
	readonly kind: "toast-expired";
}

// ---------------------------------------------------------------------------
// Union type
// ---------------------------------------------------------------------------

/** Discriminated union of all render intents the event dispatcher can produce. */
export type RenderIntent =
	// Writer
	| AppendToolResult
	| AppendSubagentReply
	| AppendBatchTiming
	| AppendNotice
	| AppendUserMessage
	// Reply block
	| ResetReplyBlock
	| ClearReplyBlock
	| SetHideThinking
	// Typewriters
	| ReplyChunk
	| ThinkingChunk
	| FlushReplyTW
	| FlushThinkingTW
	| ResetReplyTW
	| ResetThinkingTW
	// Prompt console
	| Pulse
	| ShowPendingFooter
	| HidePendingFooter
	| ShowInFlightCall
	| RemoveInFlightCall
	| UpdateInFlightCallChunk
	| StartThinking
	| StopThinking
	| SetIntent
	| SetTopicLabel
	| SetStatus
	| SetConsoleNotice
	| SetWidgetAbove
	| OnTurnComplete
	| SetFocusedCall
	| SetChunkText
	| SetCallIdentity
	| UpdateCallTokens
	| AddChildCall
	| RemoveChildCall
	| ShowToast
	| ShowBackgroundTask
	| UpdateBackgroundTask
	| SyncPendingQueue
	| SetTokenFooterText
	| CancelToolCall
	| ThinkingTick
	| ToastExpired;
