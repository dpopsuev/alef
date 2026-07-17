/**
 * TUI dispatcher unit tests — no terminal, no agent, no session required.
 * Verifies all TuiState transitions by replaying AgentEvent sequences.
 */
import { describe, expect, it, vi } from "vitest";
import { dispatchTuiEvent } from "../src/client/events.js";
import { initialTuiState, type TuiUi } from "../src/client/state.js";

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
		expect(ui.writer.addCompletedToolBlock).toHaveBeenCalledWith(
			"fs.read",
			expect.anything(),
			{},
			100,
			true,
			null,
			null,
		);
		// Single-tool batches already show elapsedMs on the tool line — no ~ · timing.
		expect(ui.writer.addBatchTiming).not.toHaveBeenCalled();
	});

	it("adds batch timing only when a multi-tool batch completes", () => {
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
		expect(ui.writer.addBatchTiming).not.toHaveBeenCalled();
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
		expect(state.batchCallCount).toBe(0);
		expect(ui.writer.addBatchTiming).toHaveBeenCalledTimes(1);
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

	it("shows each tool display in a parallel multi-tool batch (not only the last)", () => {
		const ui = makeMockUi();
		let state = initialTuiState();
		const starts = [
			{ callId: "c1", query: "tree-sitter LSP" },
			{ callId: "c2", query: "ast-grep tree-sitter" },
			{ callId: "c3", query: "LSP code intelligence CLI" },
		] as const;
		for (const start of starts) {
			state = dispatchTuiEvent(
				state,
				{
					type: "tool-start",
					callId: start.callId,
					name: "web.search",
					args: { query: start.query, numResults: 10 },
					ok: true,
				} as Parameters<typeof dispatchTuiEvent>[1],
				ui,
			);
		}
		expect(state.activeCalls.size).toBe(3);

		const ends = [
			{ callId: "c1", elapsedMs: 1400, display: "Web search: tree-sitter LSP (10 results)" },
			{ callId: "c2", elapsedMs: 1600, display: "Web search: ast-grep tree-sitter (10 results)" },
			{ callId: "c3", elapsedMs: 2300, display: "Web search: LSP code intelligence CLI (10 results)" },
		] as const;
		for (const end of ends) {
			state = dispatchTuiEvent(
				state,
				{
					type: "tool-end",
					callId: end.callId,
					elapsedMs: end.elapsedMs,
					ok: true,
					display: end.display,
					displayKind: "text/plain",
				} as Parameters<typeof dispatchTuiEvent>[1],
				ui,
			);
		}

		expect(state.activeCalls.size).toBe(0);
		const blocks = (ui.writer.addCompletedToolBlock as ReturnType<typeof vi.fn>).mock.calls;
		expect(blocks).toHaveLength(3);
		expect(blocks.map((call) => call[5])).toEqual([
			"Web search: tree-sitter LSP (10 results)",
			"Web search: ast-grep tree-sitter (10 results)",
			"Web search: LSP code intelligence CLI (10 results)",
		]);
		expect(blocks.every((call) => call[6] === "text/plain")).toBe(true);
		expect(ui.writer.addBatchTiming).toHaveBeenCalledTimes(1);
	});
});

describe("dispatchTuiEvent — discussion", { tags: ["unit"] }, () => {
	it("updates the prompt topic label when discussion changes", () => {
		const ui = makeMockUi();
		dispatchTuiEvent(
			initialTuiState(),
			{
				type: "discussion-changed",
				discussion: {
					home: { forumId: "workspace-1234", topicId: "root-topic", topicTitle: "Workspace Root" },
					active: { forumId: "workspace-1234", topicId: "topic-1", topicTitle: "Main Topic" },
					subscriptions: [
						{
							discussion: { forumId: "workspace-1234", topicId: "root-topic", topicTitle: "Workspace Root" },
							subscribedAt: 1,
							mode: "participate",
						},
						{
							discussion: { forumId: "workspace-1234", topicId: "topic-1", topicTitle: "Main Topic" },
							subscribedAt: 2,
							mode: "watch",
						},
					],
				},
			},
			ui,
		);
		expect(ui.promptConsole.setTopicLabel).toHaveBeenCalledWith("Main Topic");
	});

	it("updates the prompt topic label when session metadata refreshes", () => {
		const setDiscussion = vi.fn();
		const ui = makeMockUi();
		ui.session = {
			...ui.session,
			setDiscussion,
			getDiscussion: () => ({ forumId: "f", topicId: "t", topicTitle: "old" }),
		} as unknown as TuiUi["session"];
		const handlers = new Map([
			[
				"session.metadata.refresh",
				(payload: Record<string, unknown>, surface: { setTopicLabel: (text: string) => void }) => {
					if (typeof payload.title === "string") surface.setTopicLabel(payload.title);
				},
			],
		]);
		dispatchTuiEvent(
			initialTuiState(),
			{
				type: "adapter-signal",
				signalType: "session.metadata.refresh",
				payload: { reason: "first_message", title: "Fix topic label lag" },
			},
			ui,
			handlers,
		);
		expect(ui.promptConsole.setTopicLabel).toHaveBeenCalledWith("Fix topic label lag");
		expect(setDiscussion).toHaveBeenCalledWith({ topicTitle: "Fix topic label lag" });
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

	it("advances contextFillTokens on successive mid-turn usage events", () => {
		const ui = makeMockUi();
		let state = dispatchTuiEvent(
			initialTuiState(),
			{
				type: "token-usage",
				usage: { input: 10, output: 100, totalTokens: 20_000 },
			} as Parameters<typeof dispatchTuiEvent>[1],
			ui,
		);
		expect(state.contextFillTokens).toBe(20_000);

		state = dispatchTuiEvent(
			state,
			{
				type: "token-usage",
				usage: { input: 50, output: 200, totalTokens: 180_000 },
			} as Parameters<typeof dispatchTuiEvent>[1],
			ui,
		);
		expect(state.contextFillTokens).toBe(180_000);
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

describe("dispatchTuiEvent — message-queued", { tags: ["unit"] }, () => {
	it("syncs pending queue panel with text and length", () => {
		const ui = makeMockUi();
		dispatchTuiEvent(initialTuiState(), { type: "message-queued", queueLength: 2, text: "follow up" }, ui);
		expect(ui.promptConsole.syncPendingQueue).toHaveBeenCalledWith({
			queueLength: 2,
			text: "follow up",
		});
	});

	it("syncs drain updates without chat notices", () => {
		const ui = makeMockUi();
		dispatchTuiEvent(initialTuiState(), { type: "message-queued", queueLength: 0 }, ui);
		expect(ui.promptConsole.syncPendingQueue).toHaveBeenCalledWith({ queueLength: 0, text: undefined });
		expect(ui.writer.addNotice).not.toHaveBeenCalled();
	});
});

describe("dispatchTuiEvent — adapter-signal", { tags: ["unit"] }, () => {
	it("updates contextFillTokens after context.compacted", () => {
		const ui = makeMockUi();
		const state = dispatchTuiEvent(
			{ ...initialTuiState(), contextFillTokens: 197_000 },
			{
				type: "adapter-signal",
				signalType: "context.compacted",
				payload: {
					compactedTurns: 279,
					estimatedBefore: 197_000,
					estimatedAfter: 36_000,
				},
			},
			ui,
			new Map([
				[
					"context.compacted",
					(_payload, uiHandle) => {
						uiHandle.setNotice("compacted 279 turns, recovered ~161k tokens", 2);
					},
				],
			]),
		);

		expect(state.contextFillTokens).toBe(36_000);
		expect(ui.promptConsole.setNotice).toHaveBeenCalledWith("compacted 279 turns, recovered ~161k tokens", 2);
	});
});
