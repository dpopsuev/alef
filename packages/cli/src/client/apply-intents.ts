/**
 * applyIntents -- execute RenderIntent[] against TuiUi components.
 *
 * This is the imperative half of the event dispatch split.
 * Each intent maps to exactly one component method call.
 */

import type { RenderIntent } from "./render-intent.js";
import type { TokenFooterHandle, TuiUi } from "./state.js";

/** Apply a list of render intents to the TUI components. */
export function applyIntents(
	ui: TuiUi,
	intents: readonly RenderIntent[],
	pendingTokenFooter?: TokenFooterHandle | null,
): void {
	const { writer, replyBlock, replyTW, thinkingTW, promptConsole } = ui;

	for (const intent of intents) {
		switch (intent.kind) {
			// Writer
			case "append-tool-result":
				writer.addCompletedToolBlock(
					intent.name,
					intent.keyArg,
					intent.args,
					intent.elapsedMs,
					intent.ok,
					intent.display,
					intent.displayKind,
				);
				break;
			case "append-subagent-reply":
				writer.addSubagentReply(intent.name, intent.reply);
				break;
			case "append-batch-timing":
				writer.addBatchTiming(intent.elapsedMs);
				break;
			case "append-notice":
				writer.addNotice(intent.text);
				break;
			case "append-user-message":
				writer.addUserMessage(intent.text);
				break;

			// Reply block
			case "reset-reply-block":
				replyBlock.reset();
				break;
			case "clear-reply-block":
				replyBlock.clear();
				break;
			case "set-hide-thinking":
				replyBlock.setHideThinking(intent.hide);
				break;

			// Typewriters
			case "reply-chunk":
				replyTW.receive(intent.text);
				break;
			case "thinking-chunk":
				thinkingTW.receive(intent.text);
				break;
			case "flush-reply-tw":
				replyTW.flush();
				break;
			case "flush-thinking-tw":
				thinkingTW.flush();
				break;
			case "reset-reply-tw":
				replyTW.reset();
				break;
			case "reset-thinking-tw":
				thinkingTW.reset();
				break;

			// Prompt console
			case "pulse":
				promptConsole.pulse();
				break;
			case "show-pending-footer":
				promptConsole.showPendingFooter(intent.fg);
				break;
			case "hide-pending-footer":
				promptConsole.hidePendingFooter();
				break;
			case "show-in-flight-call":
				promptConsole.showInFlightCall(intent.callId, intent.name, intent.keyArg, intent.args);
				break;
			case "remove-in-flight-call":
				promptConsole.removeInFlightCall(intent.callId);
				break;
			case "update-in-flight-call-chunk":
				promptConsole.updateInFlightCallChunk(intent.callId, intent.text);
				break;
			case "start-thinking":
				promptConsole.startThinking();
				break;
			case "stop-thinking":
				promptConsole.stopThinking();
				break;
			case "set-intent":
				promptConsole.setIntent(intent.text);
				break;
			case "set-topic-label":
				promptConsole.setTopicLabel(intent.text);
				break;
			case "set-status":
				promptConsole.setStatus(intent.text, intent.clearAfterTurns);
				break;
			case "set-console-notice":
				promptConsole.setNotice(intent.text, intent.clearAfterTurns);
				break;
			case "set-widget-above":
				promptConsole.setWidgetAbove(intent.text);
				break;
			case "on-turn-complete":
				promptConsole.onTurnComplete();
				break;
			case "set-focused-call":
				promptConsole.setFocusedCall(intent.callId);
				break;
			case "set-chunk-text":
				promptConsole.setChunkText(intent.text);
				break;
			case "set-call-identity":
				promptConsole.setCallIdentity(intent.callId, intent.colorName, intent.address, intent.modelId);
				break;
			case "update-call-tokens":
				promptConsole.updateCallTokens(intent.callId, intent.input, intent.output);
				break;
			case "add-child-call":
				promptConsole.addChildCall(
					intent.parentCallId,
					intent.callId,
					intent.name,
					intent.keyArg,
					intent.args,
					intent.depth,
				);
				break;
			case "remove-child-call":
				promptConsole.removeChildCall(intent.parentCallId, intent.callId);
				break;
			case "show-toast":
				promptConsole.showToast(intent.message, intent.durationMs);
				break;
			case "show-background-task":
				promptConsole.showBackgroundTask(intent.taskId, intent.profile);
				break;
			case "update-background-task":
				promptConsole.updateBackgroundTask(intent.taskId, intent.status, intent.detail);
				break;
			case "sync-pending-queue": {
				const promoted = promptConsole.syncPendingQueue({
					queueLength: intent.queueLength,
					text: intent.text,
					mode: intent.mode,
				});
				for (const text of promoted) {
					writer.addUserMessage(text);
				}
				break;
			}
			case "set-token-footer-text":
				pendingTokenFooter?.setText(intent.text);
				break;
			case "cancel-tool-call":
				ui.session.cancelToolCall?.(intent.callId, intent.name);
				break;
		}
	}

	if (intents.length > 0) {
		ui.tui.requestRender();
	}
}
