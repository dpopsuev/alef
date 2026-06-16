import { trace } from "./debug-trace.js";
import { formatError } from "./errors.js";
import type { AgentEvent } from "./session.js";
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
// Unified reducer — one switch handles all TuiEvent variants.
// Adding a new AgentEvent: add a case here and in session.ts.
// Adding a new TuiInputEvent: add a variant to TuiInputEvent above and a case here.
// The exhaustive default: never guard catches missing cases at compile time.
// ---------------------------------------------------------------------------

const INSPECTOR_LINES = 12;

function renderChunkWindow(chunks: string[], scrollOffset: number): string {
	const all = chunks.join("").split("\n");
	const end = Math.max(0, all.length - scrollOffset);
	const start = Math.max(0, end - INSPECTOR_LINES);
	return all.slice(start, end).join("\n");
}

export function tuiReducer(state: TuiState, event: TuiEvent, ui: TuiUi): TuiState {
	const { writer, replyBlock, replyTW, thinkingTW, promptConsole, t, session } = ui;

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
			replyTW.flush();
			thinkingTW.flush();
			replyBlock.reset();
			promptConsole.stopThinking();
			promptConsole.hidePendingFooter();
			return { ...state, pendingFooterShown: false, pendingTokenFooter: event.tokenFooter };

		case "turn.abort":
			return { ...state, abortCurrentTurn: undefined };

		case "turn.error": {
			promptConsole.stopThinking();
			promptConsole.hidePendingFooter();
			replyTW.reset();
			thinkingTW.reset();
			replyBlock.clear();
			for (const [callId, entry] of state.activeCalls) {
				promptConsole.removeInFlightCall(callId);
				writer.addCompletedToolBlock(entry.name, entry.keyArg, 0, false, null, null);
			}
			if (!event.aborted) writer.addNotice(`[error] ${formatError(event.error)}`);
			return {
				...state,
				activeCalls: new Map(),
				batchStartedAt: null,
				pendingFooterShown: false,
				abortCurrentTurn: undefined,
			};
		}

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

		case "inspector.cycle": {
			if (state.activeCalls.size === 0) return state;
			const ids = [...state.activeCalls.keys()];
			const idx = state.focusedCallId ? ids.indexOf(state.focusedCallId) : -1;
			const nextId = ids[(idx + 1) % ids.length];
			promptConsole.setFocusedCall(nextId);
			const chunks = state.callChunks.get(nextId) ?? [];
			const tail = renderChunkWindow(chunks, state.inspectorScrollOffset);
			promptConsole.setChunkText(tail);
			return { ...state, focusedCallId: nextId };
		}

		case "inspector.close": {
			promptConsole.setFocusedCall(null);
			promptConsole.setChunkText("");
			return { ...state, focusedCallId: null, inspectorScrollOffset: 0 };
		}

		case "inspector.cancel": {
			if (!state.focusedCallId) return state;
			const entry = state.activeCalls.get(state.focusedCallId);
			if (!entry) return state;
			session.cancelToolCall?.(state.focusedCallId, entry.name);
			return state;
		}

		case "inspector.scroll": {
			if (!state.focusedCallId) return state;
			const chunks = state.callChunks.get(state.focusedCallId) ?? [];
			const totalLines = chunks.join("").split("\n").length;
			const maxScroll = Math.max(0, totalLines - INSPECTOR_LINES);
			const next = Math.max(0, Math.min(maxScroll, state.inspectorScrollOffset + event.direction * 3));
			promptConsole.setChunkText(renderChunkWindow(chunks, next));
			return { ...state, inspectorScrollOffset: next };
		}

		// ── Agent events ────────────────────────────────────────────────────

		case "tool-start": {
			const { callId, name, args } = event;
			const keyArg = keyArgFromPayload(args);
			trace("tool:start", { callId: callId.slice(0, 8), name, keyArg, activeCount: state.activeCalls.size + 1 });
			promptConsole.pulse();
			replyTW.flush();
			thinkingTW.flush();
			replyBlock.reset();
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

		case "tool-end": {
			const { callId, elapsedMs, ok, display, displayKind } = event;
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
			writer.addCompletedToolBlock(
				entry.name,
				entry.keyArg,
				elapsedMs,
				ok,
				showOutput && display?.trim() ? display : null,
				showOutput && display?.trim() ? (displayKind ?? null) : null,
			);
			const activeCalls = new Map(state.activeCalls);
			activeCalls.delete(callId);
			const callChunks = new Map(state.callChunks);
			callChunks.delete(callId);
			const batchDone = activeCalls.size === 0 && state.batchStartedAt !== null;
			if (batchDone) writer.addBatchTiming(Date.now() - (state.batchStartedAt ?? 0));
			const focusLost = state.focusedCallId === callId;
			const nextFocus = focusLost
				? activeCalls.size > 0
					? activeCalls.keys().next().value
					: null
				: state.focusedCallId;
			if (focusLost) {
				if (nextFocus && callChunks.has(nextFocus)) {
					promptConsole.setChunkText(renderChunkWindow(callChunks.get(nextFocus) ?? [], 0));
				} else {
					promptConsole.setChunkText("");
				}
				promptConsole.setFocusedCall(nextFocus ?? null);
			}
			if (batchDone) {
				promptConsole.setFocusedCall(null);
				promptConsole.setChunkText("");
			}
			return {
				...state,
				activeCalls,
				callChunks,
				batchStartedAt: batchDone ? null : state.batchStartedAt,
				focusedCallId: batchDone ? null : (nextFocus ?? null),
			};
		}

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
				state.pendingTokenFooter.setText(formatTokenUsage(input, output, t, Date.now() - state.turnStartedAt));
			}
			const cw = session.state.contextWindow;
			if (cw && totalTokens > 0) {
				const fill = totalTokens / cw;
				if (fill > 0.9) {
					writer.addNotice(
						`⚠ context ${Math.round(fill * 100)}% full (${totalTokens.toLocaleString()} / ${cw.toLocaleString()} tokens) — start a new session soon`,
					);
				} else if (fill > 0.75) {
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

		case "tool-validation-error":
			promptConsole.pulse();
			promptConsole.updateInFlightCallChunk(event.callId, `\u26a0 invalid arg '${event.field}': ${event.message}`);
			return state;

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

// Keep handleAgentEvent exported for tests that test agent events directly.
export function handleAgentEvent(state: TuiState, event: AgentEvent, ui: TuiUi): TuiState {
	return tuiReducer(state, event, ui);
}
