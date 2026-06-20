import type { TuiSignalHandler } from "@dpopsuev/alef-kernel";
import { trace } from "./debug-trace.js";
import { formatError } from "./errors.js";
import type { AgentEvent } from "./session.js";
import {
	handleInspectorCancel,
	handleInspectorClose,
	handleInspectorCycle,
	handleInspectorScroll,
	renderChunkWindow,
	updateInspectorView,
} from "./tui/inspector.js";
import { formatTokenUsage, keyArgFromPayload } from "./tui/tool-view.js";
import type { OverlayDescriptor, TokenFooterHandle, TuiState, TuiUi } from "./tui-state.js";

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

	trace("tool:end", {
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
// Organ-contributed signal handlers run first (OCP extension point).
// Built-in cases handle turn lifecycle, tool display, and inspector chrome.
// ---------------------------------------------------------------------------

export function dispatchTuiEvent(
	state: TuiState,
	event: TuiEvent,
	ui: TuiUi,
	signalHandlers?: ReadonlyMap<string, TuiSignalHandler>,
): TuiState {
	const { writer, replyBlock, replyTW, thinkingTW, promptConsole, t, session } = ui;

	if (event.type === "organ-signal" && signalHandlers) {
		const handler = signalHandlers.get(event.signalType);
		if (handler) {
			handler(event.payload, {
				setIntent: (text) => promptConsole.setIntent(text),
				setStatus: (text) => promptConsole.setStatus(text),
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
			trace("tool:start", { callId: callId.slice(0, 8), name, keyArg, activeCount: state.activeCalls.size + 1 });
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

		case "token-usage": {
			const { input, output, totalTokens } = event.usage;
			const sessionTokensTotal = state.sessionTokensTotal + input + output;
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
			return { ...state, sessionTokensTotal, pendingTokenFooter: null };
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
			promptConsole.setCallIdentity(event.callId, event.color, event.address);
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

		default:
			return state;
	}
}
