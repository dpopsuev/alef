import type { UiSignalHandler } from "@dpopsuev/alef-kernel/adapter";
import { formatErrorForUser } from "@dpopsuev/alef-kernel/errors";
import { traceEvent } from "@dpopsuev/alef-kernel/log";
import type { AgentEvent } from "@dpopsuev/alef-session/contracts";
import { formatTokenUsage, keyArgFromPayload } from "@dpopsuev/alef-tui/views";
import type { OverlayDescriptor, TokenFooterHandle, TuiState, TuiUi } from "./state.js";

/** TUI input events — dot convention (turn.start) vs AgentEvent hyphens (tool-start). */
export type TuiInputEvent =
	| { type: "overlay.show"; descriptor: OverlayDescriptor }
	| { type: "overlay.hide"; id: string }
	| { type: "turn.start"; timestamp: number }
	| { type: "turn.complete"; tokenFooter: TokenFooterHandle }
	| { type: "turn.abort" }
	| { type: "turn.error"; error: unknown; aborted: boolean }
	| { type: "abort.set"; fn: () => void }
	| { type: "abort.clear" }
	| { type: "thinking.toggle" }
	| { type: "inspector.cycle" }
	| { type: "inspector.close" }
	| { type: "inspector.scroll"; direction: -1 | 1 }
	| { type: "inspector.cancel" };

/** Union of agent-emitted events and TUI input events dispatched through the TUI state machine. */
export type TuiEvent = AgentEvent | TuiInputEvent;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONTEXT_WARNING_THRESHOLD = 0.75;
const CONTEXT_CRITICAL_THRESHOLD = 0.9;

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/** Flush pending text writers and reset the reply block between turn outputs. */
function resetUIComponents(ui: TuiUi): void {
	ui.replyTW.flush();
	ui.thinkingTW.flush();
	ui.replyBlock.reset();
}

/** Process a tool-end event: remove the in-flight card, display output, and update batch state. */
function handleToolEnd(state: TuiState, event: Extract<AgentEvent, { type: "tool-end" }>, ui: TuiUi): TuiState {
	const { callId, elapsedMs, ok, display, displayKind } = event;
	const { writer, promptConsole } = ui;

	const entry = state.activeCalls.get(callId);
	if (!entry) return state;

	traceEvent("tool:end", {
		callId: callId.slice(0, 8),
		name: entry.name,
		elapsedMs,
		ok,
		remainingActive: state.activeCalls.size - 1,
	});

	promptConsole.removeInFlightCall(callId);

	const remainingAfter = state.activeCalls.size - 1;
	const showOutput = remainingAfter === 0;

	// Prepend validation errors to display output
	const validationErrs = state.validationErrors.get(callId) ?? [];
	let enhancedDisplay = showOutput && display?.trim() ? display : null;
	if (validationErrs.length > 0 && showOutput) {
		const errSection = validationErrs.join("\n");
		enhancedDisplay = enhancedDisplay ? `${errSection}\n\n${enhancedDisplay}` : errSection;
	}

	writer.addCompletedToolBlock(
		entry.name,
		entry.keyArg,
		elapsedMs,
		ok,
		enhancedDisplay,
		showOutput && display?.trim() ? (displayKind ?? null) : null,
	);

	const innerReply = state.innerReplies.get(callId);
	if (innerReply?.trim()) {
		writer.addSubagentReply(entry.name, innerReply);
	}

	const activeCalls = new Map(state.activeCalls);
	activeCalls.delete(callId);

	const callChunks = new Map(state.callChunks);
	callChunks.delete(callId);

	// Clean up validation errors for completed call
	const validationErrors = new Map(state.validationErrors);
	validationErrors.delete(callId);

	// Clean up exit codes for completed call
	const exitCodes = new Map(state.exitCodes);
	exitCodes.delete(callId);

	// Clean up inner replies for completed call
	const innerReplies = new Map(state.innerReplies);
	innerReplies.delete(callId);

	const batchDone = activeCalls.size === 0 && state.batchStartedAt !== null;
	if (batchDone) {
		writer.addBatchTiming(Date.now() - (state.batchStartedAt ?? 0));
	}

	const focusLost = state.focusedCallId === callId;
	let nextFocus: string | null;
	if (focusLost) {
		if (activeCalls.size > 0) {
			nextFocus = activeCalls.keys().next().value ?? null;
		} else {
			nextFocus = null;
		}
	} else {
		nextFocus = state.focusedCallId;
	}

	if (focusLost) {
		updateInspectorView(state, ui, nextFocus, 0);
	}

	if (batchDone) {
		updateInspectorView(state, ui, null);
	}

	return {
		...state,
		activeCalls,
		callChunks,
		validationErrors,
		exitCodes,
		innerReplies,
		batchStartedAt: batchDone ? null : state.batchStartedAt,
		focusedCallId: batchDone ? null : (nextFocus ?? null),
	};
}

/** Handle a turn error by stopping spinners, clearing in-flight calls, and showing the error. */
function handleTurnError(state: TuiState, event: Extract<TuiInputEvent, { type: "turn.error" }>, ui: TuiUi): TuiState {
	const { promptConsole, replyTW, thinkingTW, replyBlock, writer } = ui;

	promptConsole.stopThinking();
	promptConsole.hidePendingFooter();
	replyTW.reset();
	thinkingTW.reset();
	replyBlock.clear();

	for (const [callId, entry] of state.activeCalls) {
		promptConsole.removeInFlightCall(callId);
		writer.addCompletedToolBlock(entry.name, entry.keyArg, 0, false, null, null);
	}

	if (!event.aborted) {
		writer.addNotice(`[error] ${formatErrorForUser(event.error)}`);
	}

	return {
		...state,
		activeCalls: new Map(),
		batchStartedAt: null,
		pendingFooterShown: false,
		abortCurrentTurn: undefined,
	};
}

/** Route TuiEvent through adapter signal handlers (OCP extension), then built-in transitions. */
export function dispatchTuiEvent(
	state: TuiState,
	event: TuiEvent,
	ui: TuiUi,
	signalHandlers?: ReadonlyMap<string, UiSignalHandler>,
): TuiState {
	traceEvent("tui:dispatch", { type: event.type });
	const { writer, replyBlock, replyTW, thinkingTW, promptConsole, t, session } = ui;

	if (event.type === "state-changed") {
		return state;
	}

	if (event.type === "adapter-signal" && signalHandlers) {
		const handler = signalHandlers.get(event.signalType);
		if (handler) {
			handler(event.payload, {
				setIntent: (text) => promptConsole.setIntent(text),
				setStatus: (text) => promptConsole.setStatus(text),
				setWidgetAbove: (text) => promptConsole.setWidgetAbove(text),
			});
		}
		return state;
	}

	// ── Input event handlers ────────────────────────────────────────────

	/** Handle overlay show event. */
	function onOverlayShow(e: Extract<TuiEvent, { type: "overlay.show" }>): TuiState {
		return { ...state, overlays: [...state.overlays, e.descriptor] };
	}

	/** Handle overlay hide event. */
	function onOverlayHide(e: Extract<TuiEvent, { type: "overlay.hide" }>): TuiState {
		return { ...state, overlays: state.overlays.filter((o) => o.id !== e.id) };
	}

	/** Handle turn start event. */
	function onTurnStart(e: Extract<TuiEvent, { type: "turn.start" }>): TuiState {
		promptConsole.hidePendingFooter();
		promptConsole.startThinking();
		return { ...state, pendingFooterShown: false, turnStartedAt: e.timestamp };
	}

	/** Handle turn complete event. */
	function onTurnComplete(e: Extract<TuiEvent, { type: "turn.complete" }>): TuiState {
		resetUIComponents(ui);
		promptConsole.stopThinking();
		promptConsole.hidePendingFooter();
		return { ...state, pendingFooterShown: false, pendingTokenFooter: e.tokenFooter };
	}

	/** Handle turn abort event. */
	function onTurnAbort(): TuiState {
		return { ...state, abortCurrentTurn: undefined };
	}

	/** Handle turn error event. */
	function onTurnError(e: Extract<TuiEvent, { type: "turn.error" }>): TuiState {
		return handleTurnError(state, e, ui);
	}

	/** Set the abort callback. */
	function onAbortSet(e: Extract<TuiEvent, { type: "abort.set" }>): TuiState {
		return { ...state, abortCurrentTurn: e.fn };
	}

	/** Clear the abort callback. */
	function onAbortClear(): TuiState {
		return { ...state, abortCurrentTurn: undefined };
	}

	/** Toggle thinking visibility. */
	function onThinkingToggle(): TuiState {
		const next = !replyBlock.hideThinking;
		replyBlock.setHideThinking(next);
		writer.addNotice(next ? "Thinking: hidden" : "Thinking: visible");
		return state;
	}

	/** Cycle inspector focus. */
	function onInspectorCycle(): TuiState {
		return handleInspectorCycle(state, ui);
	}

	/** Close inspector. */
	function onInspectorClose(): TuiState {
		return handleInspectorClose(state, ui);
	}

	/** Cancel inspector. */
	function onInspectorCancel(): TuiState {
		return handleInspectorCancel(state, ui);
	}

	/** Scroll inspector view. */
	function onInspectorScroll(e: Extract<TuiEvent, { type: "inspector.scroll" }>): TuiState {
		return handleInspectorScroll(state, ui, e.direction);
	}

	// ── Agent event handlers ────────────────────────────────────────────

	/** Handle tool execution start. */
	function onToolStart(e: Extract<TuiEvent, { type: "tool-start" }>): TuiState {
		const { callId, name, args } = e;
		const keyArg = keyArgFromPayload(args);
		traceEvent("tool:start", {
			callId: callId.slice(0, 8),
			name,
			keyArg,
			activeCount: state.activeCalls.size + 1,
		});
		promptConsole.pulse();
		resetUIComponents(ui);
		promptConsole.showInFlightCall(callId, name, keyArg);
		if (!state.pendingFooterShown) promptConsole.showPendingFooter(t.agentFg);
		const activeCalls = new Map(state.activeCalls);
		activeCalls.set(callId, { name, keyArg, children: new Map(), depth: 0 });
		return {
			...state,
			activeCalls,
			batchStartedAt: state.batchStartedAt ?? Date.now(),
			pendingFooterShown: true,
		};
	}

	/** Handle tool execution end. */
	function onToolEnd(e: Extract<TuiEvent, { type: "tool-end" }>): TuiState {
		return handleToolEnd(state, e, ui);
	}

	/** Handle nested tool start. */
	function onInnerToolStart(e: Extract<TuiEvent, { type: "inner-tool-start" }>): TuiState {
		const parent = state.activeCalls.get(e.parentCallId);
		if (!parent) return state;
		const childKeyArg = keyArgFromPayload(e.args);
		parent.children.set(e.callId, {
			name: e.name,
			keyArg: childKeyArg,
			parentCallId: e.parentCallId,
			children: new Map(),
			depth: parent.depth + 1,
		});
		promptConsole.addChildCall(e.parentCallId, e.callId, e.name, childKeyArg, parent.depth + 1);
		return state;
	}

	/** Handle nested tool end. */
	function onInnerToolEnd(e: Extract<TuiEvent, { type: "inner-tool-end" }>): TuiState {
		const parent = state.activeCalls.get(e.parentCallId);
		if (!parent) return state;
		parent.children.delete(e.callId);
		promptConsole.removeChildCall(e.parentCallId, e.callId);
		return state;
	}

	/** Accumulate inner agent text chunk. */
	function onInnerChunk(e: Extract<TuiEvent, { type: "inner-chunk" }>): TuiState {
		const existing = state.innerReplies.get(e.parentCallId) ?? "";
		const innerReplies = new Map(state.innerReplies);
		innerReplies.set(e.parentCallId, existing + e.text);
		return { ...state, innerReplies };
	}

	/** Process token usage report. */
	function onTokenUsage(e: Extract<TuiEvent, { type: "token-usage" }>): TuiState {
		const { input, output, totalTokens, costUsd } = e.usage;
		const sessionTokensTotal = state.sessionTokensTotal + input + output;
		const sessionInputTokens = state.sessionInputTokens + input;
		const sessionOutputTokens = state.sessionOutputTokens + output;
		const sessionCostUsd = state.sessionCostUsd + (costUsd ?? 0);
		const contextFillTokens = totalTokens > 0 ? totalTokens : state.contextFillTokens;
		if (state.pendingTokenFooter) {
			state.pendingTokenFooter.setText(
				formatTokenUsage(input, output, t, Date.now() - state.turnStartedAt, sessionTokensTotal),
			);
		}
		const contextWindow = session.state.contextWindow;
		if (contextWindow && totalTokens > 0) {
			const fill = totalTokens / contextWindow;
			if (fill > CONTEXT_CRITICAL_THRESHOLD) {
				writer.addNotice(
					`⚠ context ${Math.round(fill * 100)}% full (${totalTokens.toLocaleString()} / ${contextWindow.toLocaleString()} tokens) — start a new session soon`,
				);
			} else if (fill > CONTEXT_WARNING_THRESHOLD) {
				writer.addNotice(`context ${Math.round(fill * 100)}% full`);
			}
		}
		return {
			...state,
			sessionTokensTotal,
			sessionInputTokens,
			sessionOutputTokens,
			sessionCostUsd,
			contextFillTokens,
			pendingTokenFooter: null,
		};
	}

	/** Process streaming text chunk. */
	function onChunk(e: Extract<TuiEvent, { type: "chunk" }>): TuiState {
		promptConsole.pulse();
		replyTW.receive(e.text);
		if (!state.pendingFooterShown) {
			promptConsole.showPendingFooter(t.agentFg);
			return { ...state, pendingFooterShown: true };
		}
		return state;
	}

	/** Process thinking text chunk. */
	function onThinking(e: Extract<TuiEvent, { type: "thinking" }>): TuiState {
		promptConsole.pulse();
		thinkingTW.receive(e.text);
		return state;
	}

	/** Set subagent identity display. */
	function onSubagentIdentity(e: Extract<TuiEvent, { type: "subagent-identity" }>): TuiState {
		promptConsole.setCallIdentity(e.callId, e.color, e.address, e.modelId);
		return state;
	}

	/** Update subagent token display. */
	function onSubagentTokenUsage(e: Extract<TuiEvent, { type: "subagent-token-usage" }>): TuiState {
		promptConsole.updateCallTokens(e.callId, e.input, e.output);
		return state;
	}

	/** Process tool output chunk. */
	function onToolChunk(e: Extract<TuiEvent, { type: "tool-chunk" }>): TuiState {
		promptConsole.pulse();
		promptConsole.updateInFlightCallChunk(e.callId, e.text);
		const chunks = state.callChunks.get(e.callId) ?? [];
		chunks.push(e.text);
		const callChunks = new Map(state.callChunks);
		callChunks.set(e.callId, chunks);
		if (state.focusedCallId === e.callId) {
			const tail = renderChunkWindow(chunks, state.inspectorScrollOffset);
			promptConsole.setChunkText(tail);
		}
		return { ...state, callChunks };
	}

	/** Handle tool stall warning. */
	function onToolStall(e: Extract<TuiEvent, { type: "tool-stall" }>): TuiState {
		promptConsole.pulse();
		promptConsole.updateInFlightCallChunk(e.callId, `⏳ no output for ${Math.round(e.lastChunkMs / 1_000)}s`);
		return state;
	}

	/** Handle tool validation error. */
	function onToolValidationError(e: Extract<TuiEvent, { type: "tool-validation-error" }>): TuiState {
		promptConsole.pulse();
		const errorMsg = `⚠ invalid arg '${e.field}': ${e.message}`;
		promptConsole.updateInFlightCallChunk(e.callId, errorMsg);

		// Store validation error to display when tool completes
		const errors = state.validationErrors.get(e.callId) ?? [];
		errors.push(errorMsg);
		const validationErrors = new Map(state.validationErrors);
		validationErrors.set(e.callId, errors);

		return { ...state, validationErrors };
	}

	/** Handle LLM turn error. */
	function onLlmTurnError(e: Extract<TuiEvent, { type: "turn-error" }>): TuiState {
		promptConsole.pulse();
		writer.addNotice(`LLM error: ${e.message}`);
		return state;
	}

	/** Handle queued message notification. */
	function onMessageQueued(e: Extract<TuiEvent, { type: "message-queued" }>): TuiState {
		writer.addNotice(
			e.queueLength === 1
				? "message queued — agent will receive it after the current turn"
				: `${e.queueLength} messages queued`,
		);
		return state;
	}

	/** Track background task progress. */
	function onTaskProgress(e: Extract<TuiEvent, { type: "task-progress" }>): TuiState {
		const tasks = new Map(state.backgroundTasks);
		let task = tasks.get(e.taskId);
		if (!task) {
			task = {
				taskId: e.taskId,
				profile: "background",
				status: "running",
				startedAt: Date.now(),
				chunks: [],
			};
			tasks.set(e.taskId, task);
			promptConsole.showBackgroundTask(e.taskId, task.profile);
		}
		task.chunks.push(e.chunk);
		return { ...state, backgroundTasks: tasks };
	}

	/** Handle background task completion. */
	function onTaskCompleted(e: Extract<TuiEvent, { type: "task-completed" }>): TuiState {
		const tasks = new Map(state.backgroundTasks);
		const task = tasks.get(e.taskId);
		if (task) {
			task.status = "completed";
			task.completedAt = Date.now();
			task.reply = e.reply;
		}
		promptConsole.updateBackgroundTask(e.taskId, "completed");
		promptConsole.showToast(`Task ${e.taskId} completed (${e.profile})`, TASK_TOAST_DURATION_MS);
		return { ...state, backgroundTasks: tasks };
	}

	/** Handle background task failure. */
	function onTaskFailed(e: Extract<TuiEvent, { type: "task-failed" }>): TuiState {
		const tasks = new Map(state.backgroundTasks);
		const task = tasks.get(e.taskId);
		if (task) {
			task.status = "failed";
			task.completedAt = Date.now();
			task.error = e.error;
		}
		promptConsole.updateBackgroundTask(e.taskId, "failed", e.error);
		promptConsole.showToast(`Task ${e.taskId} failed: ${e.error}`, TASK_TOAST_DURATION_MS);
		return { ...state, backgroundTasks: tasks };
	}

	// ── Dispatch table ──────────────────────────────────────────────────

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const handlers: Partial<Record<string, (e: any) => TuiState>> = {
		"overlay.show": onOverlayShow,
		"overlay.hide": onOverlayHide,
		"turn.start": onTurnStart,
		"turn.complete": onTurnComplete,
		"turn.abort": onTurnAbort,
		"turn.error": onTurnError,
		"abort.set": onAbortSet,
		"abort.clear": onAbortClear,
		"thinking.toggle": onThinkingToggle,
		"inspector.cycle": onInspectorCycle,
		"inspector.close": onInspectorClose,
		"inspector.cancel": onInspectorCancel,
		"inspector.scroll": onInspectorScroll,
		"tool-start": onToolStart,
		"tool-end": onToolEnd,
		"inner-tool-start": onInnerToolStart,
		"inner-tool-end": onInnerToolEnd,
		"inner-chunk": onInnerChunk,
		"token-usage": onTokenUsage,
		chunk: onChunk,
		thinking: onThinking,
		"subagent-identity": onSubagentIdentity,
		"subagent-token-usage": onSubagentTokenUsage,
		"tool-chunk": onToolChunk,
		"tool-stall": onToolStall,
		"tool-validation-error": onToolValidationError,
		"turn-error": onLlmTurnError,
		"message-queued": onMessageQueued,
		"task-progress": onTaskProgress,
		"task-completed": onTaskCompleted,
		"task-failed": onTaskFailed,
	};

	const handle = handlers[event.type];
	return handle?.(event) ?? state;
}

const TASK_TOAST_DURATION_MS = 5000;

const INSPECTOR_LINES = 12;
const INSPECTOR_SCROLL_STEP = 3;

/** Render a scrollable window of tool output chunks for the inspector detail view. */
export function renderChunkWindow(chunks: string[], scrollOffset: number): string {
	const all = chunks.join("").split("\n");
	const end = Math.max(0, all.length - scrollOffset);
	const start = Math.max(0, end - INSPECTOR_LINES);
	return all.slice(start, end).join("\n");
}

/** Set the focused call in the inspector and render its chunk window. */
export function updateInspectorView(state: TuiState, ui: TuiUi, callId: string | null, scrollOffset = 0): void {
	ui.promptConsole.setFocusedCall(callId);
	if (callId && state.callChunks.has(callId)) {
		const chunks = state.callChunks.get(callId) ?? [];
		ui.promptConsole.setChunkText(renderChunkWindow(chunks, scrollOffset));
	} else {
		ui.promptConsole.setChunkText("");
	}
}

/** Cycle inspector focus to the next active tool call. */
export function handleInspectorCycle(state: TuiState, ui: TuiUi): TuiState {
	if (state.activeCalls.size === 0) return state;
	const ids = [...state.activeCalls.keys()];
	const idx = state.focusedCallId ? ids.indexOf(state.focusedCallId) : -1;
	const nextId = ids[(idx + 1) % ids.length];
	updateInspectorView(state, ui, nextId, state.inspectorScrollOffset);
	return { ...state, focusedCallId: nextId };
}

/** Close the inspector and clear focus from all tool calls. */
export function handleInspectorClose(state: TuiState, ui: TuiUi): TuiState {
	updateInspectorView(state, ui, null);
	return { ...state, focusedCallId: null, inspectorScrollOffset: 0 };
}

/** Scroll the inspector chunk detail view up or down by a fixed step. */
export function handleInspectorScroll(state: TuiState, ui: TuiUi, direction: -1 | 1): TuiState {
	if (!state.focusedCallId) return state;
	const chunks = state.callChunks.get(state.focusedCallId) ?? [];
	const totalLines = chunks.join("").split("\n").length;
	const maxScroll = Math.max(0, totalLines - INSPECTOR_LINES);
	const next = Math.max(0, Math.min(maxScroll, state.inspectorScrollOffset + direction * INSPECTOR_SCROLL_STEP));
	ui.promptConsole.setChunkText(renderChunkWindow(chunks, next));
	return { ...state, inspectorScrollOffset: next };
}

/** Cancel the currently focused tool call via the session. */
export function handleInspectorCancel(state: TuiState, ui: TuiUi): TuiState {
	if (!state.focusedCallId) return state;
	const entry = state.activeCalls.get(state.focusedCallId);
	if (!entry) return state;
	ui.session.cancelToolCall?.(state.focusedCallId, entry.name);
	return state;
}
