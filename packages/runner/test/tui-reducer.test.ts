/**
 * TUI reducer unit tests — no terminal, no agent, no session required.
 * Verifies all TuiState transitions by replaying AgentEvent sequences.
 */
import { describe, expect, it, vi } from "vitest";
import { handleAgentEvent, handleTurnError } from "../src/tui-reducer.js";
import type { TuiUi } from "../src/tui-state.js";
import { initialTuiState } from "../src/tui-state.js";

function makeMockUi(): TuiUi {
	return {
		writer: {
			addCompletedToolBlock: vi.fn(),
			addBatchTiming: vi.fn(),
			addNotice: vi.fn(),
			addTokenFooter: vi.fn(() => ({ setText: vi.fn() })),
			addUserMessage: vi.fn(),
		},
		streamingZone: { reset: vi.fn(), clear: vi.fn() },
		replyTW: { receive: vi.fn(), flush: vi.fn(), reset: vi.fn() },
		thinkingTW: { receive: vi.fn(), flush: vi.fn(), reset: vi.fn() },
		consoleZone: {
			pulse: vi.fn(),
			showPendingFooter: vi.fn() as (fg: unknown) => void,
			hidePendingFooter: vi.fn(),
			showInFlightCall: vi.fn(),
			removeInFlightCall: vi.fn(),
			updateInFlightCallChunk: vi.fn(),
			stopThinking: vi.fn(),
			isThinking: false,
		},
		tui: { requestRender: vi.fn() } as unknown as TuiUi["tui"],
		t: { agentFg: "#fff", dimFg: "#888", accentFg: "#00f" } as unknown as TuiUi["t"],
		session: { state: { contextWindow: 100_000 } } as unknown as TuiUi["session"],
	};
}

describe("tuiReducer — tool-start / tool-end", { tags: ["unit"] }, () => {
	it("adds call to activeCalls on tool-start", () => {
		const ui = makeMockUi();
		const state = handleAgentEvent(
			initialTuiState(),
			{
				type: "tool-start",
				callId: "c1",
				name: "fs.read",
				args: { path: "foo.ts" },
				ok: true,
			} as Parameters<typeof handleAgentEvent>[1],
			ui,
		);

		expect(state.activeCalls.size).toBe(1);
		expect(state.activeCalls.get("c1")).toMatchObject({ name: "fs.read" });
		expect(state.batchStartedAt).toBeGreaterThan(0);
		expect(state.pendingFooterShown).toBe(true);
	});

	it("removes call from activeCalls on tool-end", () => {
		const ui = makeMockUi();
		let state = handleAgentEvent(
			initialTuiState(),
			{
				type: "tool-start",
				callId: "c1",
				name: "fs.read",
				args: {},
				ok: true,
			} as Parameters<typeof handleAgentEvent>[1],
			ui,
		);

		state = handleAgentEvent(
			state,
			{
				type: "tool-end",
				callId: "c1",
				elapsedMs: 100,
				ok: true,
				display: "",
				displayKind: "text/plain",
			} as Parameters<typeof handleAgentEvent>[1],
			ui,
		);

		expect(state.activeCalls.size).toBe(0);
		expect(state.batchStartedAt).toBe(0);
		expect(ui.writer.addCompletedToolBlock).toHaveBeenCalledWith("fs.read", expect.anything(), 100, true, null);
		expect(ui.writer.addBatchTiming).toHaveBeenCalled();
	});

	it("tracks parallel calls independently", () => {
		const ui = makeMockUi();
		let state = initialTuiState();
		state = handleAgentEvent(
			state,
			{ type: "tool-start", callId: "c1", name: "fs.read", args: {}, ok: true } as Parameters<
				typeof handleAgentEvent
			>[1],
			ui,
		);
		state = handleAgentEvent(
			state,
			{ type: "tool-start", callId: "c2", name: "fs.grep", args: {}, ok: true } as Parameters<
				typeof handleAgentEvent
			>[1],
			ui,
		);

		expect(state.activeCalls.size).toBe(2);

		state = handleAgentEvent(
			state,
			{
				type: "tool-end",
				callId: "c1",
				elapsedMs: 50,
				ok: true,
				display: "",
				displayKind: "text/plain",
			} as Parameters<typeof handleAgentEvent>[1],
			ui,
		);
		expect(state.activeCalls.size).toBe(1);
		expect(state.batchStartedAt).toBeGreaterThan(0);

		state = handleAgentEvent(
			state,
			{
				type: "tool-end",
				callId: "c2",
				elapsedMs: 80,
				ok: true,
				display: "",
				displayKind: "text/plain",
			} as Parameters<typeof handleAgentEvent>[1],
			ui,
		);
		expect(state.activeCalls.size).toBe(0);
		expect(state.batchStartedAt).toBe(0);
	});
});

describe("tuiReducer — token-usage", { tags: ["unit"] }, () => {
	it("accumulates sessionTokensTotal", () => {
		const ui = makeMockUi();
		let state = handleAgentEvent(
			initialTuiState(),
			{
				type: "token-usage",
				usage: { input: 100, output: 50, totalTokens: 150 },
			} as Parameters<typeof handleAgentEvent>[1],
			ui,
		);
		expect(state.sessionTokensTotal).toBe(150);

		state = handleAgentEvent(
			state,
			{
				type: "token-usage",
				usage: { input: 200, output: 100, totalTokens: 300 },
			} as Parameters<typeof handleAgentEvent>[1],
			ui,
		);
		expect(state.sessionTokensTotal).toBe(450);
	});

	it("emits context warning above 90%", () => {
		const ui = makeMockUi();
		handleAgentEvent(
			initialTuiState(),
			{
				type: "token-usage",
				usage: { input: 80_000, output: 12_000, totalTokens: 92_000 },
			} as Parameters<typeof handleAgentEvent>[1],
			ui,
		);
		expect(ui.writer.addNotice).toHaveBeenCalledWith(expect.stringContaining("context 92% full"));
	});
});

describe("tuiReducer — handleTurnError", { tags: ["unit"] }, () => {
	it("clears activeCalls and resets state on error", () => {
		const ui = makeMockUi();
		let state = handleAgentEvent(
			initialTuiState(),
			{
				type: "tool-start",
				callId: "c1",
				name: "shell.exec",
				args: {},
				ok: true,
			} as Parameters<typeof handleAgentEvent>[1],
			ui,
		);

		state = handleTurnError(state, new Error("network timeout"), false, ui);

		expect(state.activeCalls.size).toBe(0);
		expect(state.batchStartedAt).toBe(0);
		expect(state.pendingFooterShown).toBe(false);
		expect(ui.writer.addNotice).toHaveBeenCalledWith(expect.stringContaining("network timeout"));
	});

	it("suppresses error message when aborted", () => {
		const ui = makeMockUi();
		const state = handleTurnError(initialTuiState(), new Error("aborted"), true, ui);
		expect(state.activeCalls.size).toBe(0);
		expect(ui.writer.addNotice).not.toHaveBeenCalled();
	});
});

describe("tuiReducer — pure reducer properties", { tags: ["unit"] }, () => {
	it("unknown event types return state unchanged", () => {
		const ui = makeMockUi();
		const initial = initialTuiState();
		const result = handleAgentEvent(
			initial,
			{ type: "unknown-event" } as unknown as Parameters<typeof handleAgentEvent>[1],
			ui,
		);
		expect(result).toBe(initial);
	});

	it("tool-end for unknown callId returns state unchanged", () => {
		const ui = makeMockUi();
		const initial = initialTuiState();
		const result = handleAgentEvent(
			initial,
			{
				type: "tool-end",
				callId: "nonexistent",
				elapsedMs: 0,
				ok: true,
				display: "",
				displayKind: "text/plain",
			} as Parameters<typeof handleAgentEvent>[1],
			ui,
		);
		expect(result).toBe(initial);
	});
});
