import { formatError } from "@dpopsuev/alef-agent/errors";
import type { UiSignalHandler } from "@dpopsuev/alef-kernel/adapter";
import { traceEvent } from "@dpopsuev/alef-kernel/log";
import type { AgentEvent } from "@dpopsuev/alef-session/contracts";
import { formatTokenUsage, keyArgFromPayload } from "@dpopsuev/alef-tui/views";
import type { OverlayDescriptor, TokenFooterHandle, TuiState, TuiUi } from "./state.js";

// ---------------------------------------------------------------------------
// TuiInputEvent — typed events from the Input layer (keyboard, editor, modal)
// Convention: AgentEvent types use hyphens (tool-start), TuiInputEvent uses
// dots (turn.start). Both inhabit TuiEvent but are visually distinct.
// ---------------------------------------------------------------------------

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

export type TuiEvent = AgentEvent | TuiInputEvent;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONTEXT_WARNING_THRESHOLD = 0.75;
const CONTEXT_CRITICAL_THRESHOLD = 0.9;

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

function resetUIComponents(ui: TuiUi): void {
	ui.replyTW.flush();
	ui.thinkingTW.flush();
	ui.replyBlock.reset();
}

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
		writer.addNotice(`[error] ${formatError(event.error)}`);
	}

	return {
		...state,
		activeCalls: new Map(),
		batchStartedAt: null,
		pendingFooterShown: false,
		abortCurrentTurn: undefined,
	};
}

// ---------------------------------------------------------------------------
// TUI Dispatcher — routes events to UI components.
// Adapter-contributed signal handlers run first (OCP extension point).
// Built-in cases handle turn lifecycle, tool display, and inspector chrome.
// ---------------------------------------------------------------------------

export function dispatchTuiEvent(
	state: TuiState,
	event: TuiEvent,
	ui: TuiUi,
	signalHandlers?: ReadonlyMap<string, UiSignalHandler>,
): TuiState {
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

	switch (event.type) {
		// ── Input events ────────────────────────────────────────────────────

		case "overlay.show":
			return { ...state, overlays: [...state.overlays, event.descriptor] };

		case "overlay.hide":
			return { ...state, overlays: state.overlays.filter((o) => o.id !== event.id) };

		case "turn.start":
			promptConsole.hidePendingFooter();
			promptConsole.startThinking();
			return { ...state, pendingFooterShown: false, turnStartedAt: event.timestamp };

		case "turn.complete":
			resetUIComponents(ui);
			promptConsole.stopThinking();
			promptConsole.hidePendingFooter();
			return { ...state, pendingFooterShown: false, pendingTokenFooter: event.tokenFooter };

		case "turn.abort":
			return { ...state, abortCurrentTurn: undefined };

		case "turn.error":
			return handleTurnError(state, event, ui);

		case "abort.set":
			return { ...state, abortCurrentTurn: event.fn };

		case "abort.clear":
			return { ...state, abortCurrentTurn: undefined };

		case "thinking.toggle": {
			const next = !replyBlock.hideThinking;
			replyBlock.setHideThinking(next);
			writer.addNotice(next ? "Thinking: hidden" : "Thinking: visible");
			return state;
		}

		case "inspector.cycle":
			return handleInspectorCycle(state, ui);

		case "inspector.close":
			return handleInspectorClose(state, ui);

		case "inspector.cancel":
			return handleInspectorCancel(state, ui);

		case "inspector.scroll":
			return handleInspectorScroll(state, ui, event.direction);

		// ── Agent events ────────────────────────────────────────────────────

		case "tool-start": {
			const { callId, name, args } = event;
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

		case "tool-end":
			return handleToolEnd(state, event, ui);

		case "inner-tool-start": {
			const parent = state.activeCalls.get(event.parentCallId);
			if (!parent) return state;
			const childKeyArg = keyArgFromPayload(event.args);
			parent.children.set(event.callId, {
				name: event.name,
				keyArg: childKeyArg,
				parentCallId: event.parentCallId,
				children: new Map(),
				depth: parent.depth + 1,
			});
			promptConsole.addChildCall(event.parentCallId, event.callId, event.name, childKeyArg, parent.depth + 1);
			return state;
		}

		case "inner-tool-end": {
			const parent = state.activeCalls.get(event.parentCallId);
			if (!parent) return state;
			parent.children.delete(event.callId);
			promptConsole.removeChildCall(event.parentCallId, event.callId);
			return state;
		}

		case "inner-chunk": {
			const existing = state.innerReplies.get(event.parentCallId) ?? "";
			const innerReplies = new Map(state.innerReplies);
			innerReplies.set(event.parentCallId, existing + event.text);
			return { ...state, innerReplies };
		}

		case "token-usage": {
			const { input, output, totalTokens, costUsd } = event.usage;
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

		case "chunk":
			promptConsole.pulse();
			replyTW.receive(event.text);
			if (!state.pendingFooterShown) {
				promptConsole.showPendingFooter(t.agentFg);
				return { ...state, pendingFooterShown: true };
			}
			return state;

		case "thinking":
			promptConsole.pulse();
			thinkingTW.receive(event.text);
			return state;

		case "subagent-identity": {
			promptConsole.setCallIdentity(event.callId, event.color, event.address, event.modelId);
			return state;
		}

		case "subagent-token-usage": {
			promptConsole.updateCallTokens(event.callId, event.input, event.output);
			return state;
		}

		case "tool-chunk": {
			promptConsole.pulse();
			promptConsole.updateInFlightCallChunk(event.callId, event.text);
			const chunks = state.callChunks.get(event.callId) ?? [];
			chunks.push(event.text);
			const callChunks = new Map(state.callChunks);
			callChunks.set(event.callId, chunks);
			if (state.focusedCallId === event.callId) {
				const tail = renderChunkWindow(chunks, state.inspectorScrollOffset);
				promptConsole.setChunkText(tail);
			}
			return { ...state, callChunks };
		}

		case "tool-stall":
			promptConsole.pulse();
			promptConsole.updateInFlightCallChunk(
				event.callId,
				`\u23f3 no output for ${Math.round(event.lastChunkMs / 1_000)}s`,
			);
			return state;

		case "tool-validation-error": {
			promptConsole.pulse();
			const errorMsg = `\u26a0 invalid arg '${event.field}': ${event.message}`;
			promptConsole.updateInFlightCallChunk(event.callId, errorMsg);

			// Store validation error to display when tool completes
			const errors = state.validationErrors.get(event.callId) ?? [];
			errors.push(errorMsg);
			const validationErrors = new Map(state.validationErrors);
			validationErrors.set(event.callId, errors);

			return { ...state, validationErrors };
		}

		case "turn-error":
			promptConsole.pulse();
			writer.addNotice(`LLM error: ${event.message}`);
			return state;

		case "message-queued":
			writer.addNotice(
				event.queueLength === 1
					? "message queued — agent will receive it after the current turn"
					: `${event.queueLength} messages queued`,
			);
			return state;

		case "task-progress": {
			const tasks = new Map(state.backgroundTasks);
			let task = tasks.get(event.taskId);
			if (!task) {
				task = {
					taskId: event.taskId,
					profile: "background",
					status: "running",
					startedAt: Date.now(),
					chunks: [],
				};
				tasks.set(event.taskId, task);
				promptConsole.showBackgroundTask(event.taskId, task.profile);
			}
			task.chunks.push(event.chunk);
			return { ...state, backgroundTasks: tasks };
		}

		case "task-completed": {
			const tasks = new Map(state.backgroundTasks);
			const task = tasks.get(event.taskId);
			if (task) {
				task.status = "completed";
				task.completedAt = Date.now();
				task.reply = event.reply;
			}
			promptConsole.updateBackgroundTask(event.taskId, "completed");
			promptConsole.showToast(`Task ${event.taskId} completed (${event.profile})`, TASK_TOAST_DURATION_MS);
			return { ...state, backgroundTasks: tasks };
		}

		case "task-failed": {
			const tasks = new Map(state.backgroundTasks);
			const task = tasks.get(event.taskId);
			if (task) {
				task.status = "failed";
				task.completedAt = Date.now();
				task.error = event.error;
			}
			promptConsole.updateBackgroundTask(event.taskId, "failed", event.error);
			promptConsole.showToast(`Task ${event.taskId} failed: ${event.error}`, TASK_TOAST_DURATION_MS);
			return { ...state, backgroundTasks: tasks };
		}

		default:
			return state;
	}
}

const TASK_TOAST_DURATION_MS = 5000;

const INSPECTOR_LINES = 12;
const INSPECTOR_SCROLL_STEP = 3;

export function renderChunkWindow(chunks: string[], scrollOffset: number): string {
	const all = chunks.join("").split("\n");
	const end = Math.max(0, all.length - scrollOffset);
	const start = Math.max(0, end - INSPECTOR_LINES);
	return all.slice(start, end).join("\n");
}

export function updateInspectorView(state: TuiState, ui: TuiUi, callId: string | null, scrollOffset = 0): void {
	ui.promptConsole.setFocusedCall(callId);
	if (callId && state.callChunks.has(callId)) {
		const chunks = state.callChunks.get(callId) ?? [];
		ui.promptConsole.setChunkText(renderChunkWindow(chunks, scrollOffset));
	} else {
		ui.promptConsole.setChunkText("");
	}
}

export function handleInspectorCycle(state: TuiState, ui: TuiUi): TuiState {
	if (state.activeCalls.size === 0) return state;
	const ids = [...state.activeCalls.keys()];
	const idx = state.focusedCallId ? ids.indexOf(state.focusedCallId) : -1;
	const nextId = ids[(idx + 1) % ids.length];
	updateInspectorView(state, ui, nextId, state.inspectorScrollOffset);
	return { ...state, focusedCallId: nextId };
}

export function handleInspectorClose(state: TuiState, ui: TuiUi): TuiState {
	updateInspectorView(state, ui, null);
	return { ...state, focusedCallId: null, inspectorScrollOffset: 0 };
}

export function handleInspectorScroll(state: TuiState, ui: TuiUi, direction: -1 | 1): TuiState {
	if (!state.focusedCallId) return state;
	const chunks = state.callChunks.get(state.focusedCallId) ?? [];
	const totalLines = chunks.join("").split("\n").length;
	const maxScroll = Math.max(0, totalLines - INSPECTOR_LINES);
	const next = Math.max(0, Math.min(maxScroll, state.inspectorScrollOffset + direction * INSPECTOR_SCROLL_STEP));
	ui.promptConsole.setChunkText(renderChunkWindow(chunks, next));
	return { ...state, inspectorScrollOffset: next };
}

export function handleInspectorCancel(state: TuiState, ui: TuiUi): TuiState {
	if (!state.focusedCallId) return state;
	const entry = state.activeCalls.get(state.focusedCallId);
	if (!entry) return state;
	ui.session.cancelToolCall?.(state.focusedCallId, entry.name);
	return state;
}
