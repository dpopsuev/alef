/**
 * Invariant: a mid-turn follow-up must live in the pending-queue panel OR the
 * chat scrollback — never both at once.
 *
 * Desired UX (pi-mono pendingMessagesContainer):
 * - While the agent is busy and the prompt is queued → panel only (streaming zone)
 * - After the agent drains/consumes it → scrollback only (normal user message)
 */

import { PendingQueuePanel } from "@dpopsuev/alef-tui";
import { describe, expect, it, vi } from "vitest";
import { dispatchEvent } from "../src/client/events.js";
import { type DispatchPorts, initialDispatchState } from "../src/client/state.js";
import { createSubmitHandler } from "../src/client/submit.js";

const theme = {
	item: (s: string) => s,
	hint: (s: string) => s,
};

/** Surfaces that can display a user prompt during/after queueing. */
function surfaces(text: string, scrollback: string[], panel: PendingQueuePanel) {
	const inScrollback = scrollback.includes(text);
	const inPanel = panel.getItems().some((entry) => entry.text === text);
	return { inScrollback, inPanel, both: inScrollback && inPanel, either: inScrollback || inPanel };
}

describe("queued message display exclusivity", { tags: ["unit"] }, () => {
	it("while queued, text is in the pending panel XOR scrollback — never both", () => {
		const text = "Also tell me which tools do you have";
		const scrollback: string[] = [];
		const panel = new PendingQueuePanel({ theme });

		// Correct enqueue path: panel only.
		panel.push({ text, prefix: "Queued" });
		panel.setLength(1);

		const view = surfaces(text, scrollback, panel);
		expect(view.either, "queued prompt must be visible somewhere").toBe(true);
		expect(view.both, "queued prompt must not appear in scrollback and panel together").toBe(false);
		expect(view.inPanel).toBe(true);
		expect(view.inScrollback).toBe(false);
	});

	it("after drain (queueLength 0), text may move to scrollback and must leave the panel", () => {
		const text = "Also tell me which tools do you have";
		const scrollback: string[] = [];
		const panel = new PendingQueuePanel({ theme });

		panel.push({ text, prefix: "Queued" });
		panel.setLength(1);
		expect(surfaces(text, scrollback, panel).inPanel).toBe(true);

		// Drain consumed the message — panel clears; scrollback gains the user line.
		panel.setLength(0);
		scrollback.push(text);

		const view = surfaces(text, scrollback, panel);
		expect(view.inPanel).toBe(false);
		expect(view.inScrollback).toBe(true);
		expect(view.both).toBe(false);
	});

	it("submit while a turn is active must not dual-write scrollback + pending panel", async () => {
		const text = "Also tell me which tools do you have";
		const userMessages: string[] = [];
		const received: string[] = [];
		const panel = new PendingQueuePanel({ theme });

		const handler = createSubmitHandler({
			actorRoutes: undefined,
			session: {
				state: { id: "s", modelId: "m", contextWindow: 100_000 },
				getModel: () => "m",
				setModel: () => {},
				getThinking: () => "off",
				setThinking: () => {},
				setTurnController: () => {},
				dispose: () => {},
				subscribe: () => () => {},
				send: async () => "done",
				receive: (content: string) => {
					received.push(content);
				},
			},
			writer: {
				addUserMessage: (t: string) => userMessages.push(t),
				addNotice: () => {},
				addTokenFooter: () => ({ setText: () => {} }),
				addCompletedToolBlock: () => {},
				addBatchTiming: () => {},
				addSubagentReply: () => {},
			},
			addToHistory: () => {},
			addHistoryEntry: () => {},
			clearEditor: () => {},
			dispatch: () => {},
			ctx: () => ({}) as never,
			onThinkingStop: () => {},
			isTurnActive: () => true,
		} as never);

		await handler(text);

		expect(received).toEqual([text]);
		expect(userMessages, "must not scrollback until drain").not.toContain(text);

		const ui = {
			writer: {
				addUserMessage: (t: string) => userMessages.push(t),
				addNotice: vi.fn(),
				addTokenFooter: () => ({ setText: () => {} }),
				addCompletedToolBlock: vi.fn(),
				addAgentReply: vi.fn(),
				addBatchTiming: vi.fn(),
				addSubagentReply: vi.fn(),
				clearAll: vi.fn(),
			},
			promptConsole: {
				syncPendingQueue: (opts: { queueLength: number; text?: string }) => {
					if (opts.text) {
						panel.push({ text: opts.text, prefix: "Queued" });
						panel.setLength(opts.queueLength);
						return [];
					}
					const before = panel.getItems();
					const keep = Math.max(0, opts.queueLength);
					const promoted: string[] = [];
					for (let i = 0; i < Math.max(0, before.length - keep); i++) {
						promoted.push(before[i]!.text);
					}
					panel.setLength(keep);
					return promoted;
				},
				pulse: vi.fn(),
				showPendingFooter: vi.fn(),
				hidePendingFooter: vi.fn(),
				showInFlightCall: vi.fn(),
				removeInFlightCall: vi.fn(),
				updateInFlightCallChunk: vi.fn(),
				startThinking: vi.fn(),
				stopThinking: vi.fn(),
				setIntent: vi.fn(),
				setTopicLabel: vi.fn(),
				setStatus: vi.fn(),
				setNotice: vi.fn(),
				onTurnComplete: vi.fn(),
				setWidgetAbove: vi.fn(),
				isThinking: true,
				widgetSlotAbove: { addChild: vi.fn(), removeChild: vi.fn() },
				widgetSlotBelow: { addChild: vi.fn(), removeChild: vi.fn() },
				setFocusedCall: vi.fn(),
				setChunkText: vi.fn(),
				setCallIdentity: vi.fn(),
				updateCallTokens: vi.fn(),
				addChildCall: vi.fn(),
				removeChildCall: vi.fn(),
				showToast: vi.fn(),
				showBackgroundTask: vi.fn(),
				updateBackgroundTask: vi.fn(),
			},
			replyBlock: { reset: vi.fn(), clear: vi.fn(), hideThinking: false, setHideThinking: vi.fn() },
			replyTW: { receive: vi.fn(), flush: vi.fn(), reset: vi.fn() },
			thinkingTW: { receive: vi.fn(), flush: vi.fn(), reset: vi.fn() },
			tui: { requestRender: vi.fn() },
			t: { mutedFg: "#888" },
			session: { state: { contextWindow: 100_000 } },
		} as unknown as DispatchPorts;

		// Mid-turn queue signal (as reasoner emits when turnActive).
		dispatchEvent(initialDispatchState(), { type: "message-queued", queueLength: 1, text }, ui);

		expect(surfaces(text, userMessages, panel).inPanel).toBe(true);
		expect(surfaces(text, userMessages, panel).inScrollback).toBe(false);
		expect(surfaces(text, userMessages, panel).both).toBe(false);

		// Drain: panel clears, text moves to scrollback.
		dispatchEvent(initialDispatchState(), { type: "message-queued", queueLength: 0 }, ui);

		expect(surfaces(text, userMessages, panel).inPanel).toBe(false);
		expect(surfaces(text, userMessages, panel).inScrollback).toBe(true);
		expect(surfaces(text, userMessages, panel).both).toBe(false);
	});
});
