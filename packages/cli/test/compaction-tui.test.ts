/**
 * Compaction TUI contracts:
 * - mode (INSERT/NORMAL) stays on the lower delimiter left
 * - compacting/compacted notices stay on the right and clear
 * - submit during idle compaction parks (does not start a racing turn / drop)
 * - mid-turn park still surfaces via message-queued
 */

import type { TUI } from "@dpopsuev/alef-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PromptConsole } from "../src/client/console.js";
import { dispatchTuiEvent } from "../src/client/events.js";
import { initialTuiState, type TuiUi } from "../src/client/state.js";
import { createSubmitHandler, flushCompactionPark, parkCompactionMessage } from "../src/client/submit.js";
import { bold, color } from "../src/client/theme.js";

vi.mock("@dpopsuev/alef-session/compaction", () => ({
	isCompacting: vi.fn(() => false),
}));

import { isCompacting } from "@dpopsuev/alef-session/compaction";

const isCompactingMock = vi.mocked(isCompacting);

afterEach(() => {
	isCompactingMock.mockReturnValue(false);
});

function getTheme() {
	const W = { ansi16: 37 };
	return {
		userFg: W,
		userBg: W,
		agentFg: W,
		agentBg: W,
		primaryFg: W,
		secondaryFg: W,
		mutedFg: W,
		accentFg: W,
		brightFg: W,
		okFg: { ansi16: 32 },
		warnFg: { ansi16: 33 },
		errFg: { ansi16: 31 },
	};
}

function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("compaction delimiter notices", { tags: ["unit"] }, () => {
	it("keeps INSERT on the left while compacted notice is on the right", () => {
		const width = 72;
		const children: { render(w: number): string[] }[] = [];
		const fakeTui = {
			addChild: (c: { render(w: number): string[] }) => children.push(c),
			removeChild: () => {},
			requestRender: () => {},
			addInputListener: () => {},
			setFocus: () => {},
			setStickyFrom: () => {},
			terminal: { rows: 40, cols: width },
		} as unknown as TUI;

		const zone = new PromptConsole(fakeTui, getTheme(), "test-model");
		zone.mount();
		zone.setStatus(color(bold("INSERT"), getTheme().accentFg));
		zone.setNotice("compacted 356 turns, recovered ~178k tokens", 2);

		const wrapper = children.find((child) => child.render(width).some((line) => stripAnsi(line).includes("INSERT")));
		if (!wrapper) throw new Error("EditorWrapper not found");
		const bottom = stripAnsi(wrapper.render(width).at(-1)!);
		expect(bottom.startsWith("─ INSERT ")).toBe(true);
		expect(bottom).toContain("compacted 356 turns");
		expect(bottom.indexOf("INSERT")).toBeLessThan(bottom.indexOf("compacted"));
	});

	it("upper topic title keeps corner dashes and uses accentFg", () => {
		const width = 48;
		const children: { render(w: number): string[] }[] = [];
		const fakeTui = {
			addChild: (c: { render(w: number): string[] }) => children.push(c),
			removeChild: () => {},
			requestRender: () => {},
			addInputListener: () => {},
			setFocus: () => {},
			setStickyFrom: () => {},
			terminal: { rows: 40, cols: width },
		} as unknown as TUI;

		const theme = { ...getTheme(), accentFg: { ansi16: 95 } };
		const zone = new PromptConsole(fakeTui, theme, "test-model");
		zone.mount();
		zone.setTopicLabel("review-session");

		const wrapper = children.find((child) =>
			child.render(width).some((line) => stripAnsi(line).includes("review-session")),
		);
		if (!wrapper) throw new Error("EditorWrapper not found");
		const top = wrapper.render(width)[0]!;
		const plain = stripAnsi(top);
		expect(plain.startsWith("─")).toBe(true);
		expect(plain.endsWith("─")).toBe(true);
		expect(plain).toContain(" review-session ");
		expect(top).toContain("\x1b[95m");
	});

	it("clears the right-side notice after clearAfterTurns without wiping mode", () => {
		const width = 60;
		const children: { render(w: number): string[] }[] = [];
		const fakeTui = {
			addChild: (c: { render(w: number): string[] }) => children.push(c),
			removeChild: () => {},
			requestRender: () => {},
			addInputListener: () => {},
			setFocus: () => {},
			setStickyFrom: () => {},
			terminal: { rows: 40, cols: width },
		} as unknown as TUI;

		const zone = new PromptConsole(fakeTui, getTheme(), "test-model");
		zone.mount();
		zone.setStatus("INSERT");
		zone.setNotice("compacted 10 turns, recovered ~1k tokens", 1);
		zone.onTurnComplete();

		const wrapper = children.find((child) => child.render(width).some((line) => stripAnsi(line).includes("INSERT")))!;
		const bottom = stripAnsi(wrapper.render(width).at(-1)!);
		expect(bottom).toContain("INSERT");
		expect(bottom).not.toContain("compacted");
	});

	it("context.compacting uses setNotice (not setStatus) so mode stays on the left", () => {
		const setNotice = vi.fn();
		const setStatus = vi.fn();
		const ui = {
			writer: {
				addCompletedToolBlock: vi.fn(),
				addAgentReply: vi.fn(),
				addBatchTiming: vi.fn(),
				addNotice: vi.fn(),
				addSubagentReply: vi.fn(),
				addTokenFooter: vi.fn(() => ({ setText: vi.fn() })),
				addUserMessage: vi.fn(),
				clearAll: vi.fn(),
			},
			replyBlock: { reset: vi.fn(), clear: vi.fn(), hideThinking: false, setHideThinking: vi.fn() },
			replyTW: { receive: vi.fn(), flush: vi.fn(), reset: vi.fn() },
			thinkingTW: { receive: vi.fn(), flush: vi.fn(), reset: vi.fn() },
			promptConsole: {
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
				setStatus,
				setNotice,
				onTurnComplete: vi.fn(),
				isThinking: false,
				setWidgetAbove: vi.fn(),
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
				syncPendingQueue: vi.fn(() => []),
			},
			tui: { requestRender: vi.fn() },
			t: { mutedFg: "#888", accentFg: "#0ff" },
			session: { state: { contextWindow: 100_000 } },
		} as unknown as TuiUi;

		const handlers = new Map([
			[
				"context.compacting",
				(payload: Record<string, unknown>, handle: { setNotice: (t: string) => void }) => {
					if (payload.active) handle.setNotice("Compacting context...");
				},
			],
			[
				"context.compacted",
				(_payload: Record<string, unknown>, handle: { setNotice: (t: string, n?: number) => void }) => {
					handle.setNotice("compacted 356 turns, recovered ~178k tokens", 2);
				},
			],
		]);

		dispatchTuiEvent(
			initialTuiState(),
			{ type: "adapter-signal", signalType: "context.compacting", payload: { active: true } },
			ui,
			handlers,
		);
		expect(setNotice).toHaveBeenCalledWith("Compacting context...", undefined);
		expect(setStatus).not.toHaveBeenCalled();

		dispatchTuiEvent(
			initialTuiState(),
			{
				type: "adapter-signal",
				signalType: "context.compacted",
				payload: { compactedTurns: 356, estimatedBefore: 200_000, estimatedAfter: 22_000 },
			},
			ui,
			handlers,
		);
		expect(setNotice).toHaveBeenCalledWith("compacted 356 turns, recovered ~178k tokens", 2);
		expect(setStatus).not.toHaveBeenCalled();
	});
});

describe("submit during compaction parks instead of dropping", { tags: ["unit"] }, () => {
	it("idle + isCompacting parks locally (no receive/send) and surfaces message-queued", async () => {
		isCompactingMock.mockReturnValue(true);
		const received: Array<{ text: string; delivery?: string }> = [];
		const sent: string[] = [];
		const userMessages: string[] = [];
		const dispatched: Array<Record<string, unknown>> = [];

		const session = {
			state: { id: "s", modelId: "m", contextWindow: 100_000 },
			getModel: () => "m",
			setModel: () => {},
			getThinking: () => "off",
			setThinking: () => {},
			setTurnController: () => {},
			dispose: () => {},
			subscribe: () => () => {},
			send: async (text: string) => {
				sent.push(text);
				return "done";
			},
			receive: (text: string, opts?: { delivery?: string }) => {
				received.push({ text, delivery: opts?.delivery });
			},
		};

		const handler = createSubmitHandler({
			actorRoutes: undefined,
			session,
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
			dispatch: (event: unknown) => dispatched.push(event as Record<string, unknown>),
			ctx: () => ({}) as never,
			onThinkingStop: () => {},
			isTurnActive: () => false,
		} as never);

		await handler("explore those codebases as prior art");

		expect(sent, "must not start a racing send while compacting").toHaveLength(0);
		expect(received, "must not receive until compact ends").toHaveLength(0);
		expect(userMessages, "must not scrollback until flush").toHaveLength(0);
		expect(dispatched).toContainEqual(
			expect.objectContaining({
				type: "message-queued",
				text: "explore those codebases as prior art",
				mode: "followUp",
			}),
		);

		// Compact ends → flush delivers parked message.
		isCompactingMock.mockReturnValue(false);
		const { flushCompactionPark } = await import("../src/client/submit.js");
		const flushed = flushCompactionPark(session);
		expect(flushed).toEqual(["explore those codebases as prior art"]);
		expect(received).toEqual([{ text: "explore those codebases as prior art", delivery: "followUp" }]);
	});

	it("active turn + isCompacting parks with steer receive (reasoner emits message-queued)", async () => {
		isCompactingMock.mockReturnValue(true);
		const received: Array<{ text: string; delivery?: string }> = [];

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
				receive: (text: string, opts?: { delivery?: string }) => {
					received.push({ text, delivery: opts?.delivery });
				},
			},
			writer: {
				addUserMessage: () => {},
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

		await handler("follow-up during overflow compact");

		expect(received).toEqual([{ text: "follow-up during overflow compact", delivery: "steer" }]);
	});

	it("context.compacting active=false flushes the idle park into receive + scrollback", () => {
		parkCompactionMessage("parked during compact");
		const received: Array<{ text: string; delivery?: string }> = [];
		const userMessages: string[] = [];
		const syncPendingQueue = vi.fn(() => []);

		const ui = {
			writer: {
				addCompletedToolBlock: vi.fn(),
				addAgentReply: vi.fn(),
				addBatchTiming: vi.fn(),
				addNotice: vi.fn(),
				addSubagentReply: vi.fn(),
				addTokenFooter: vi.fn(() => ({ setText: vi.fn() })),
				addUserMessage: (t: string) => userMessages.push(t),
				clearAll: vi.fn(),
			},
			replyBlock: { reset: vi.fn(), clear: vi.fn(), hideThinking: false, setHideThinking: vi.fn() },
			replyTW: { receive: vi.fn(), flush: vi.fn(), reset: vi.fn() },
			thinkingTW: { receive: vi.fn(), flush: vi.fn(), reset: vi.fn() },
			promptConsole: {
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
				isThinking: false,
				setWidgetAbove: vi.fn(),
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
				syncPendingQueue,
			},
			tui: { requestRender: vi.fn() },
			t: { mutedFg: "#888" },
			session: {
				state: { contextWindow: 100_000 },
				receive: (text: string, opts?: { delivery?: string }) => {
					received.push({ text, delivery: opts?.delivery });
				},
				send: async () => "done",
			},
		} as unknown as TuiUi;

		dispatchTuiEvent(
			initialTuiState(),
			{ type: "adapter-signal", signalType: "context.compacting", payload: { active: false } },
			ui,
			new Map(),
		);

		expect(received).toEqual([{ text: "parked during compact", delivery: "followUp" }]);
		expect(userMessages).toEqual(["parked during compact"]);
		expect(syncPendingQueue).toHaveBeenCalledWith({ queueLength: 0 });
		expect(flushCompactionPark(ui.session).length).toBe(0);
	});
});
