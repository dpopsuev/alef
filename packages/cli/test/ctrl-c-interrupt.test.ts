/**
 * Ctrl+C interrupt behaviour tests.
 *
 * Covers:
 * - turn.interrupt event dispatched on Ctrl+C mid-turn
 * - dispatcher calls abortCurrentTurn, resets UI, adds notice
 * - idle Ctrl+C still disposes session and stops TUI
 * - handleRawInput routes Ctrl+C through the event system
 * - Kitty keyboard protocol Ctrl+C works (matchesKey, not ===)
 */

import { Container, matchesKey } from "@dpopsuev/alef-tui";
import { ChatLog } from "@dpopsuev/alef-tui/views";
import { describe, expect, it, vi } from "vitest";
import { dispatchTuiEvent } from "../src/client/events.js";
import { handleCtrlC } from "../src/client/handlers.js";
import { handleRawInput } from "../src/client/runner.js";
import { initialTuiState, type TuiUi } from "../src/client/state.js";
import { getTheme } from "../src/client/theme.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockUi(): TuiUi {
	return {
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
			showPendingFooter: vi.fn() as (fg: unknown) => void,
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
			syncPendingQueue: vi.fn(() => []),
		},
		tui: { requestRender: vi.fn() } as unknown as TuiUi["tui"],
		t: { agentFg: "#fff", mutedFg: "#888", accentFg: "#00f" } as unknown as TuiUi["t"],
		session: { state: { contextWindow: 100_000 } } as unknown as TuiUi["session"],
	};
}

function makeTui() {
	return { stop: vi.fn(), removeChild: vi.fn(), addChild: vi.fn(), requestRender: vi.fn() };
}

function makeSession() {
	return {
		state: { id: "test", modelId: "test-model", contextWindow: 128_000 },
		getModel: vi.fn(() => "test-model"),
		setModel: vi.fn(),
		getThinking: vi.fn(() => "off"),
		setThinking: vi.fn(),
		setTurnController: vi.fn(),
		dispose: vi.fn(),
		subscribe: vi.fn(() => () => {}),
	};
}

function makeCtx(overrides: Record<string, unknown> = {}) {
	const t = getTheme();
	return {
		t,
		writer: new ChatLog(new Container(), t),
		tui: makeTui(),
		session: makeSession(),
		dispatch: vi.fn(),
		abortCurrentTurn: undefined as (() => void) | undefined,
		setAbortCurrentTurn: vi.fn(),
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// dispatchTuiEvent — turn.interrupt
// ---------------------------------------------------------------------------

describe("dispatchTuiEvent -- turn.interrupt", { tags: ["unit"] }, () => {
	it("calls abortCurrentTurn and clears it from state", () => {
		const ui = makeMockUi();
		const abort = vi.fn();
		const state = { ...initialTuiState(), abortCurrentTurn: abort };

		const next = dispatchTuiEvent(state, { type: "turn.interrupt" }, ui);

		expect(abort).toHaveBeenCalledOnce();
		expect(next.abortCurrentTurn).toBeUndefined();
	});

	it("adds '(interrupted)' notice", () => {
		const ui = makeMockUi();
		const state = { ...initialTuiState(), abortCurrentTurn: vi.fn() };

		dispatchTuiEvent(state, { type: "turn.interrupt" }, ui);

		expect(ui.writer.addNotice).toHaveBeenCalledWith("(interrupted)");
	});

	it("stops thinking spinner", () => {
		const ui = makeMockUi();
		const state = { ...initialTuiState(), abortCurrentTurn: vi.fn() };

		dispatchTuiEvent(state, { type: "turn.interrupt" }, ui);

		expect(ui.promptConsole.stopThinking).toHaveBeenCalled();
	});

	it("resets reply block and typewriters", () => {
		const ui = makeMockUi();
		const state = { ...initialTuiState(), abortCurrentTurn: vi.fn() };

		dispatchTuiEvent(state, { type: "turn.interrupt" }, ui);

		expect(ui.replyTW.flush).toHaveBeenCalled();
		expect(ui.thinkingTW.flush).toHaveBeenCalled();
		expect(ui.replyBlock.reset).toHaveBeenCalled();
	});

	it("drains activeCalls, completing them as failed", () => {
		const ui = makeMockUi();
		const activeCalls = new Map([
			["c1", { name: "fs.read", keyArg: "a.ts", args: { path: "a.ts" }, children: new Map(), depth: 0 }],
			["c2", { name: "shell.exec", keyArg: "ls", args: { command: "ls" }, children: new Map(), depth: 0 }],
		]);
		const state = { ...initialTuiState(), activeCalls, abortCurrentTurn: vi.fn() };

		const next = dispatchTuiEvent(state, { type: "turn.interrupt" }, ui);

		expect(next.activeCalls.size).toBe(0);
		expect(ui.promptConsole.removeInFlightCall).toHaveBeenCalledTimes(2);
	});

	it("requests a render", () => {
		const ui = makeMockUi();
		const state = { ...initialTuiState(), abortCurrentTurn: vi.fn() };

		dispatchTuiEvent(state, { type: "turn.interrupt" }, ui);

		expect(ui.tui.requestRender).toHaveBeenCalled();
	});

	it("is a no-op when no turn is active (no abortCurrentTurn)", () => {
		const ui = makeMockUi();
		const state = initialTuiState();

		const next = dispatchTuiEvent(state, { type: "turn.interrupt" }, ui);

		expect(next).toBe(state);
		expect(ui.writer.addNotice).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// handleRawInput -- Ctrl+C dispatches turn.interrupt when mid-turn
// ---------------------------------------------------------------------------

describe("handleRawInput -- Ctrl+C dispatches turn.interrupt", { tags: ["unit"] }, () => {
	it("dispatches turn.interrupt when abortCurrentTurn is set", () => {
		const dispatch = vi.fn();
		const abort = vi.fn();
		const state = { ...initialTuiState(), abortCurrentTurn: abort };
		const ctx = makeCtx({ abortCurrentTurn: abort });

		const handled = handleRawInput(
			"\x03",
			state,
			dispatch,
			() => ctx,
			() => false,
		);

		expect(handled).toBe(true);
		expect(dispatch).toHaveBeenCalledWith({ type: "turn.interrupt" });
	});

	it("dispatches turn.interrupt for Kitty protocol Ctrl+C (\\x1b[99;5u)", () => {
		const dispatch = vi.fn();
		const abort = vi.fn();
		const state = { ...initialTuiState(), abortCurrentTurn: abort };
		const ctx = makeCtx({ abortCurrentTurn: abort });

		const handled = handleRawInput(
			"\x1b[99;5u",
			state,
			dispatch,
			() => ctx,
			() => false,
		);

		expect(handled).toBe(true);
		expect(dispatch).toHaveBeenCalledWith({ type: "turn.interrupt" });
	});

	it("calls handleCtrlC for idle exit (no abortCurrentTurn)", () => {
		const dispatch = vi.fn();
		const state = initialTuiState();
		const ctx = makeCtx();

		const handled = handleRawInput(
			"\x03",
			state,
			dispatch,
			() => ctx,
			() => false,
		);

		expect(handled).toBe(true);
		// Idle path: disposes session and stops TUI
		expect(ctx.session.dispose).toHaveBeenCalledOnce();
		expect(ctx.tui.stop).toHaveBeenCalledOnce();
	});
});

// ---------------------------------------------------------------------------
// handleCtrlC -- idle path preserved
// ---------------------------------------------------------------------------

describe("handleCtrlC -- idle path", { tags: ["unit"] }, () => {
	it("disposes session and stops TUI when idle", () => {
		const ctx = makeCtx();
		handleCtrlC(ctx);
		expect(ctx.session.dispose).toHaveBeenCalledOnce();
		expect(ctx.tui.stop).toHaveBeenCalledOnce();
	});

	it("does not dispatch turn.interrupt when idle", () => {
		const ctx = makeCtx();
		handleCtrlC(ctx);
		expect(ctx.dispatch).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// matchesKey -- Kitty protocol coverage
// ---------------------------------------------------------------------------

describe("matchesKey -- Kitty Ctrl+C", { tags: ["unit"] }, () => {
	it("matches raw \\x03", () => {
		expect(matchesKey("\x03", "ctrl+c")).toBe(true);
	});

	it("matches Kitty protocol \\x1b[99;5u", () => {
		expect(matchesKey("\x1b[99;5u", "ctrl+c")).toBe(true);
	});

	it("does not match unrelated sequences", () => {
		expect(matchesKey("\x1b[A", "ctrl+c")).toBe(false);
	});
});
