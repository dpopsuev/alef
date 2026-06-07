import { trace } from "./debug-trace.js";
import { formatError } from "./errors.js";
import type { AgentEvent } from "./session.js";
import { formatTokenUsage, keyArgFromPayload, makeToolOutputComponent } from "./tui/tool-view.js";
import type { TuiState, TuiUi } from "./tui-state.js";

export function handleAgentEvent(state: TuiState, event: AgentEvent, ui: TuiUi): TuiState {
	const { writer, streamingZone, replyTW, thinkingTW, consoleZone, t, session } = ui;

	switch (event.type) {
		case "tool-start": {
			const { callId, name, args } = event;
			const keyArg = keyArgFromPayload(args);
			trace("tool:start", { callId: callId.slice(0, 8), name, keyArg, activeCount: state.activeCalls.size + 1 });
			consoleZone.pulse();
			replyTW.flush();
			thinkingTW.flush();
			streamingZone.reset();
			consoleZone.showInFlightCall(callId, name, keyArg);
			const activeCalls = new Map(state.activeCalls);
			activeCalls.set(callId, { name, keyArg });
			return {
				...state,
				activeCalls,
				batchStartedAt: state.activeCalls.size === 0 ? Date.now() : state.batchStartedAt,
				pendingFooterShown: showFooterIfNeeded(state, consoleZone, t),
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
				display?.trim() ? makeToolOutputComponent(display, displayKind, t) : null,
			);
			const activeCalls = new Map(state.activeCalls);
			activeCalls.delete(callId);
			const batchDone = activeCalls.size === 0 && state.batchStartedAt > 0;
			if (batchDone) writer.addBatchTiming(Date.now() - state.batchStartedAt);
			return {
				...state,
				activeCalls,
				batchStartedAt: batchDone ? 0 : state.batchStartedAt,
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
			return showFooterIfNeeded(state, consoleZone, t) === state.pendingFooterShown
				? state
				: { ...state, pendingFooterShown: true };

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

function showFooterIfNeeded(state: TuiState, consoleZone: TuiUi["consoleZone"], t: TuiUi["t"]): boolean {
	if (!state.pendingFooterShown) {
		consoleZone.showPendingFooter(t.agentFg);
		return true;
	}
	return true;
}

export function handleTurnError(state: TuiState, error: unknown, aborted: boolean, ui: TuiUi): TuiState {
	const { writer, consoleZone, replyTW, thinkingTW, streamingZone } = ui;
	consoleZone.stopThinking();
	consoleZone.hidePendingFooter();
	replyTW.reset();
	thinkingTW.reset();
	streamingZone.clear();
	for (const [callId, entry] of state.activeCalls) {
		consoleZone.removeInFlightCall(callId);
		writer.addCompletedToolBlock(entry.name, entry.keyArg, 0, false, null);
	}
	if (!aborted) writer.addNotice(`[error] ${formatError(error)}`);
	return { ...state, activeCalls: new Map(), batchStartedAt: 0, pendingFooterShown: false };
}
