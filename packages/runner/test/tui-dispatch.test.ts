/**
 * TUI dispatcher unit tests — no terminal, no agent, no session required.
 * Verifies all TuiState transitions by replaying AgentEvent sequences.
 */
import { describe, expect, it, vi } from "vitest";
import { dispatchTuiEvent } from "../src/tui-dispatch.js";
import { initialTuiState, type TuiUi } from "../src/tui-state.js";

function makeMockUi(): TuiUi {
	return {
		writer: {
			addCompletedToolBlock: vi.fn(),
			addBatchTiming: vi.fn(),
			addNotice: vi.fn(),
			addSubagentReply: vi.fn(),
			addTokenFooter: vi.fn(() => ({ setText: vi.fn() })),
			addUserMessage: vi.fn(),
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
			setStatus: vi.fn(),
			isThinking: false,
			setWidgetAbove: vi.fn(),
			widgetSlotAbove: { addChild: vi.fn(), removeChild: vi.fn() },
			widgetSlotBelow: { addChild: vi.fn(), removeChild: vi.fn() },
			setFocusedCall: vi.fn(),
			setChunkText: vi.fn(),
			setCallIdentity: vi.fn(),
			addChildCall: vi.fn(),
			removeChildCall: vi.fn(),
		},
		tui: { requestRender: vi.fn() } as unknown as TuiUi["tui"],
		t: { agentFg: "#fff", mutedFg: "#888", accentFg: "#00f" } as unknown as TuiUi["t"],
		session: { state: { contextWindow: 100_000 } } as unknown as TuiUi["session"],
	};
}

describe("dispatchTuiEvent — tool-start / tool-end", { tags: ["unit"] }, () => {
	it("adds call to activeCalls on tool-start", () => {
		const ui = makeMockUi();
		const state = dispatchTuiEvent(
			initialTuiState(),
			{
				type: "tool-start",
				callId: "c1",
				name: "fs.read",
				args: { path: "foo.ts" },
				ok: true,
			} as Parameters<typeof dispatchTuiEvent>[1],
			ui,
		);

		expect(state.activeCalls.size).toBe(1);
		expect(state.activeCalls.get("c1")).toMatchObject({ name: "fs.read" });
		expect(state.batchStartedAt).toBeGreaterThan(0);
		expect(state.pendingFooterShown).toBe(true);
	});

	it("removes call from activeCalls on tool-end", () => {
		const ui = makeMockUi();
		let state = dispatchTuiEvent(
			initialTuiState(),
			{
				type: "tool-start",
				callId: "c1",
				name: "fs.read",
				args: {},
				ok: true,
			} as Parameters<typeof dispatchTuiEvent>[1],
			ui,
		);

		state = dispatchTuiEvent(
			state,
			{
				type: "tool-end",
				callId: "c1",
				elapsedMs: 100,
				ok: true,
				display: "",
				displayKind: "text/plain",
			} as Parameters<typeof dispatchTuiEvent>[1],
			ui,
		);

		expect(state.activeCalls.size).toBe(0);
		expect(state.batchStartedAt).toBeNull();
		expect(ui.writer.addCompletedToolBlock).toHaveBeenCalledWith("fs.read", expect.anything(), 100, true, null, null);
		expect(ui.writer.addBatchTiming).toHaveBeenCalled();
	});

	it("tracks parallel calls independently", () => {
		const ui = makeMockUi();
		let state = initialTuiState();
		state = dispatchTuiEvent(
			state,
			{ type: "tool-start", callId: "c1", name: "fs.read", args: {}, ok: true } as Parameters<
				typeof dispatchTuiEvent
			>[1],
			ui,
		);
		state = dispatchTuiEvent(
			state,
			{ type: "tool-start", callId: "c2", name: "fs.grep", args: {}, ok: true } as Parameters<
				typeof dispatchTuiEvent
			>[1],
			ui,
		);

		expect(state.activeCalls.size).toBe(2);

		state = dispatchTuiEvent(
			state,
			{
				type: "tool-end",
				callId: "c1",
				elapsedMs: 50,
				ok: true,
				display: "",
				displayKind: "text/plain",
			} as Parameters<typeof dispatchTuiEvent>[1],
			ui,
		);
		expect(state.activeCalls.size).toBe(1);
		expect(state.batchStartedAt).toBeGreaterThan(0);

		state = dispatchTuiEvent(
			state,
			{
				type: "tool-end",
				callId: "c2",
				elapsedMs: 80,
				ok: true,
				display: "",
				displayKind: "text/plain",
			} as Parameters<typeof dispatchTuiEvent>[1],
			ui,
		);
		expect(state.activeCalls.size).toBe(0);
		expect(state.batchStartedAt).toBeNull();
	});

	it("suppresses display output while other tools are still active", () => {
		const ui = makeMockUi();
		let state = initialTuiState();
		state = dispatchTuiEvent(
			state,
			{ type: "tool-start", callId: "c1", name: "agent.run", args: {} } as Parameters<typeof dispatchTuiEvent>[1],
			ui,
		);
		state = dispatchTuiEvent(
			state,
			{ type: "tool-start", callId: "c2", name: "agent.run", args: {} } as Parameters<typeof dispatchTuiEvent>[1],
			ui,
		);

		state = dispatchTuiEvent(
			state,
			{
				type: "tool-end",
				callId: "c1",
				elapsedMs: 50,
				ok: true,
				display: "Full subagent response text here",
				displayKind: "text/plain",
			} as Parameters<typeof dispatchTuiEvent>[1],
			ui,
		);
		expect(ui.writer.addCompletedToolBlock).toHaveBeenCalledWith("agent.run", "", 50, true, null, null);
	});

	it("shows display output for last tool in batch", () => {
		const ui = makeMockUi();
		let state = initialTuiState();
		state = dispatchTuiEvent(
			state,
			{ type: "tool-start", callId: "c1", name: "agent.run", args: {} } as Parameters<typeof dispatchTuiEvent>[1],
			ui,
		);
		state = dispatchTuiEvent(
			state,
			{ type: "tool-start", callId: "c2", name: "agent.run", args: {} } as Parameters<typeof dispatchTuiEvent>[1],
			ui,
		);
		state = dispatchTuiEvent(
			state,
			{ type: "tool-end", callId: "c1", elapsedMs: 50, ok: true, display: "", displayKind: undefined } as Parameters<
				typeof dispatchTuiEvent
			>[1],
			ui,
		);
		(ui.writer.addCompletedToolBlock as ReturnType<typeof vi.fn>).mockClear();

		state = dispatchTuiEvent(
			state,
			{
				type: "tool-end",
				callId: "c2",
				elapsedMs: 80,
				ok: true,
				display: "Last tool output should show",
				displayKind: "text/plain",
			} as Parameters<typeof dispatchTuiEvent>[1],
			ui,
		);
		expect(ui.writer.addCompletedToolBlock).toHaveBeenCalledWith(
			"agent.run",
			"",
			80,
			true,
			"Last tool output should show",
			"text/plain",
		);
	});
});

describe("dispatchTuiEvent — token-usage", { tags: ["unit"] }, () => {
	it("accumulates sessionTokensTotal", () => {
		const ui = makeMockUi();
		let state = dispatchTuiEvent(
			initialTuiState(),
			{
				type: "token-usage",
				usage: { input: 100, output: 50, totalTokens: 150 },
			} as Parameters<typeof dispatchTuiEvent>[1],
			ui,
		);
		expect(state.sessionTokensTotal).toBe(150);

		state = dispatchTuiEvent(
			state,
			{
				type: "token-usage",
				usage: { input: 200, output: 100, totalTokens: 300 },
			} as Parameters<typeof dispatchTuiEvent>[1],
			ui,
		);
		expect(state.sessionTokensTotal).toBe(450);
	});

	it("emits context warning above 90%", () => {
		const ui = makeMockUi();
		dispatchTuiEvent(
			initialTuiState(),
			{
				type: "token-usage",
				usage: { input: 80_000, output: 12_000, totalTokens: 92_000 },
			} as Parameters<typeof dispatchTuiEvent>[1],
			ui,
		);
		expect(ui.writer.addNotice).toHaveBeenCalledWith(expect.stringContaining("context 92% full"));
	});
});

describe("dispatchTuiEvent — handleTurnError", { tags: ["unit"] }, () => {
	it("clears activeCalls and resets state on error", () => {
		const ui = makeMockUi();
		let state = dispatchTuiEvent(
			initialTuiState(),
			{
				type: "tool-start",
				callId: "c1",
				name: "shell.exec",
				args: {},
				ok: true,
			} as Parameters<typeof dispatchTuiEvent>[1],
			ui,
		);

		state = dispatchTuiEvent(state, { type: "turn.error", error: new Error("network timeout"), aborted: false }, ui);

		expect(state.activeCalls.size).toBe(0);
		expect(state.batchStartedAt).toBeNull();
		expect(state.pendingFooterShown).toBe(false);
		expect(ui.writer.addNotice).toHaveBeenCalledWith(expect.stringContaining("Request timed out"));
	});

	it("suppresses error message when aborted", () => {
		const ui = makeMockUi();
		const state = dispatchTuiEvent(
			initialTuiState(),
			{ type: "turn.error", error: new Error("aborted"), aborted: true },
			ui,
		);
		expect(state.activeCalls.size).toBe(0);
		expect(ui.writer.addNotice).not.toHaveBeenCalled();
	});
});

describe("dispatchTuiEvent — TuiInputEvent", { tags: ["unit"] }, () => {
	it("overlay.show adds descriptor to overlays", () => {
		const ui = makeMockUi();
		const desc = { id: "picker", component: {} as unknown as import("@dpopsuev/alef-tui").Component };

		const state = dispatchTuiEvent(initialTuiState(), { type: "overlay.show", descriptor: desc }, ui);
		expect(state.overlays).toHaveLength(1);
		expect(state.overlays[0]?.id).toBe("picker");
	});

	it("overlay.hide removes descriptor by id", () => {
		const ui = makeMockUi();
		const desc = { id: "picker", component: {} as unknown as import("@dpopsuev/alef-tui").Component };

		let state = dispatchTuiEvent(initialTuiState(), { type: "overlay.show", descriptor: desc }, ui);
		state = dispatchTuiEvent(state, { type: "overlay.hide", id: "picker" }, ui);
		expect(state.overlays).toHaveLength(0);
	});

	it("turn.start resets pendingFooterShown and records timestamp", () => {
		const ui = makeMockUi();

		const ts = Date.now();
		const state = dispatchTuiEvent(
			{ ...initialTuiState(), pendingFooterShown: true },
			{ type: "turn.start", timestamp: ts },
			ui,
		);
		expect(state.pendingFooterShown).toBe(false);
		expect(state.turnStartedAt).toBe(ts);
		expect(ui.promptConsole.startThinking).toHaveBeenCalled();
	});

	it("abort.set stores fn, abort.clear removes it", () => {
		const ui = makeMockUi();

		const fn = vi.fn();
		let state = dispatchTuiEvent(initialTuiState(), { type: "abort.set", fn }, ui);
		expect(state.abortCurrentTurn).toBe(fn);
		state = dispatchTuiEvent(state, { type: "abort.clear" }, ui);
		expect(state.abortCurrentTurn).toBeUndefined();
	});

	it("turn.error clears active calls and abortCurrentTurn", async () => {
		const ui = makeMockUi();

		let state = dispatchTuiEvent(
			initialTuiState(),
			{
				type: "tool-start",
				callId: "c1",
				name: "shell.exec",
				args: {},
				ok: true,
			} as Parameters<typeof dispatchTuiEvent>[1],
			ui,
		);
		state = dispatchTuiEvent(state, { type: "turn.error", error: new Error("fail"), aborted: false }, ui);
		expect(state.activeCalls.size).toBe(0);
		expect(state.abortCurrentTurn).toBeUndefined();
		expect(ui.writer.addNotice).toHaveBeenCalledWith(expect.stringContaining("fail"));
	});
});

describe("dispatchTuiEvent — pure reducer properties", { tags: ["unit"] }, () => {
	it("unknown event types return state unchanged", () => {
		const ui = makeMockUi();
		const initial = initialTuiState();
		const result = dispatchTuiEvent(
			initial,
			{ type: "unknown-event" } as unknown as Parameters<typeof dispatchTuiEvent>[1],
			ui,
		);
		expect(result).toBe(initial);
	});

	it("tool-end for unknown callId returns state unchanged", () => {
		const ui = makeMockUi();
		const initial = initialTuiState();
		const result = dispatchTuiEvent(
			initial,
			{
				type: "tool-end",
				callId: "nonexistent",
				elapsedMs: 0,
				ok: true,
				display: "",
				displayKind: "text/plain",
			} as Parameters<typeof dispatchTuiEvent>[1],
			ui,
		);
		expect(result).toBe(initial);
	});
});
