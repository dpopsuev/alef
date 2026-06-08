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
	| { type: "thinking.toggle" };

export type TuiEvent = AgentEvent | TuiInputEvent;

// ---------------------------------------------------------------------------
// Unified reducer — one switch handles all TuiEvent variants.
// Adding a new AgentEvent: add a case here and in session.ts.
// Adding a new TuiInputEvent: add a variant to TuiInputEvent above and a case here.
// The exhaustive default: never guard catches missing cases at compile time.
// ---------------------------------------------------------------------------

export function tuiReducer(state: TuiState, event: TuiEvent, ui: TuiUi): TuiState {
	const { writer, streamingZone, replyTW, thinkingTW, consoleZone, t, session } = ui;

	switch (event.type) {
		// ── Input events ────────────────────────────────────────────────────

		case "overlay.show":
			return { ...state, overlays: [...state.overlays, event.descriptor] };

		case "overlay.hide":
			return { ...state, overlays: state.overlays.filter((o) => o.id !== event.id) };

		case "turn.start":
			consoleZone.hidePendingFooter();
			consoleZone.startThinking();
			return { ...state, pendingFooterShown: false, turnStartedAt: event.timestamp };

		case "turn.complete":
			replyTW.flush();
			thinkingTW.flush();
			streamingZone.reset();
			consoleZone.stopThinking();
			consoleZone.hidePendingFooter();
			return { ...state, pendingFooterShown: false, pendingTokenFooter: event.tokenFooter };

		case "turn.abort":
			return { ...state, abortCurrentTurn: undefined };

		case "turn.error": {
			consoleZone.stopThinking();
			consoleZone.hidePendingFooter();
			replyTW.reset();
			thinkingTW.reset();
			streamingZone.clear();
			for (const [callId, entry] of state.activeCalls) {
				consoleZone.removeInFlightCall(callId);
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
			const next = !streamingZone.hideThinking;
			streamingZone.setHideThinking(next);
			writer.addNotice(next ? "Thinking: hidden" : "Thinking: visible");
			return state;
		}

		// ── Agent events ────────────────────────────────────────────────────

		case "tool-start": {
			const { callId, name, args } = event;
			const keyArg = keyArgFromPayload(args);
			trace("tool:start", { callId: callId.slice(0, 8), name, keyArg, activeCount: state.activeCalls.size + 1 });
			consoleZone.pulse();
			replyTW.flush();
			thinkingTW.flush();
			streamingZone.reset();
			consoleZone.showInFlightCall(callId, name, keyArg);
			if (!state.pendingFooterShown) consoleZone.showPendingFooter(t.agentFg);
			const activeCalls = new Map(state.activeCalls);
			activeCalls.set(callId, { name, keyArg });
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
			consoleZone.removeInFlightCall(callId);
			writer.addCompletedToolBlock(
				entry.name,
				entry.keyArg,
				elapsedMs,
				ok,
				display?.trim() ? display : null,
				display?.trim() ? (displayKind ?? null) : null,
			);
			const activeCalls = new Map(state.activeCalls);
			activeCalls.delete(callId);
			const batchDone = activeCalls.size === 0 && state.batchStartedAt !== null;
			if (batchDone) writer.addBatchTiming(Date.now() - (state.batchStartedAt ?? 0));
			return {
				...state,
				activeCalls,
				batchStartedAt: batchDone ? null : state.batchStartedAt,
			};
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
			consoleZone.pulse();
			replyTW.receive(event.text);
			if (!state.pendingFooterShown) {
				consoleZone.showPendingFooter(t.agentFg);
				return { ...state, pendingFooterShown: true };
			}
			return state;

		case "thinking":
			consoleZone.pulse();
			thinkingTW.receive(event.text);
			return state;

		case "tool-chunk":
			consoleZone.pulse();
			consoleZone.updateInFlightCallChunk(event.callId, event.text);
			return state;

		case "tool-stall":
			consoleZone.pulse();
			consoleZone.updateInFlightCallChunk(
				event.callId,
				`\u23f3 no output for ${Math.round(event.lastChunkMs / 1_000)}s`,
			);
			return state;

		case "tool-validation-error":
			consoleZone.pulse();
			consoleZone.updateInFlightCallChunk(event.callId, `\u26a0 invalid arg '${event.field}': ${event.message}`);
			return state;

		case "turn-error":
			consoleZone.pulse();
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
