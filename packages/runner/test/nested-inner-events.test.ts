/**
 * Recursive inner-tool-start/end events reach the TUI reducer.
 * Verifies that agent A delegating to agent B which calls fs.read
 * produces nested ActiveCall children in the TUI state.
 */

import { describe, expect, it } from "vitest";
import { dispatchTuiEvent } from "../src/tui-dispatch.js";
import { initialTuiState } from "../src/tui-state.js";

function noopUi() {
	const calls: string[] = [];
	return {
		writer: {
			addCompletedToolBlock: () => {},
			addBatchTiming: () => {},
			addNotice: () => {},
			addTokenFooter: () => ({ setText: () => {} }),
			addUserMessage: () => {},
		},
		replyBlock: { reset: () => {}, clear: () => {}, hideThinking: false, setHideThinking: () => {} },
		replyTW: { receive: () => {}, flush: () => {}, reset: () => {} },
		thinkingTW: { receive: () => {}, flush: () => {}, reset: () => {} },
		promptConsole: {
			pulse: () => {},
			showPendingFooter: () => {},
			hidePendingFooter: () => {},
			showInFlightCall: (id: string) => calls.push(`show:${id}`),
			removeInFlightCall: (id: string) => calls.push(`remove:${id}`),
			updateInFlightCallChunk: () => {},
			startThinking: () => {},
			stopThinking: () => {},
			setIntent: () => {},
			setStatus: () => {},
			isThinking: false,
			widgetSlotAbove: { addChild: () => {}, removeChild: () => {} },
			widgetSlotBelow: { addChild: () => {}, removeChild: () => {} },
			setFocusedCall: () => {},
			setChunkText: () => {},
			setCallIdentity: () => {},
			addChildCall: (parentId: string, childId: string) => calls.push(`child:${parentId}->${childId}`),
			removeChildCall: (parentId: string, childId: string) => calls.push(`unchild:${parentId}->${childId}`),
		},
		tui: { requestRender: () => {} },
		t: {
			primaryFg: { ansi16: 37 },
			secondaryFg: { ansi16: 36 },
			mutedFg: { ansi16: 90 },
			accentFg: { ansi16: 95 },
			okFg: { ansi16: 32 },
			warnFg: { ansi16: 33 },
			errFg: { ansi16: 31 },
			userFg: { ansi16: 37 },
			agentFg: { ansi16: 36 },
			userBg: { ansi16: 0 },
			agentBg: { ansi16: 0 },
		},
		session: { state: { id: "test", modelId: "test", contextWindow: 200000 }, cancelToolCall: () => {} },
		calls,
	};
}

describe("nested inner-tool events", { tags: ["unit"] }, () => {
	it("inner-tool-start creates a child in the parent ActiveCall", () => {
		const ui = noopUi();
		let state = initialTuiState();

		state = dispatchTuiEvent(
			state,
			{
				type: "tool-start",
				callId: "parent-1",
				name: "agent.run",
				args: { text: "read a file" },
			},
			ui,
		);

		expect(state.activeCalls.has("parent-1")).toBe(true);

		state = dispatchTuiEvent(
			state,
			{
				type: "inner-tool-start",
				parentCallId: "parent-1",
				callId: "child-1",
				name: "fs.read",
				args: { path: "src/index.ts" },
			},
			ui,
		);

		const parent = state.activeCalls.get("parent-1");
		expect(parent?.children.has("child-1")).toBe(true);
		expect(parent?.children.get("child-1")?.name).toBe("fs.read");
		expect(parent?.children.get("child-1")?.depth).toBe(1);
		expect(ui.calls).toContain("child:parent-1->child-1");
	});

	it("inner-tool-end removes the child", () => {
		const ui = noopUi();
		let state = initialTuiState();

		state = dispatchTuiEvent(
			state,
			{
				type: "tool-start",
				callId: "parent-1",
				name: "agent.run",
				args: { text: "read" },
			},
			ui,
		);

		state = dispatchTuiEvent(
			state,
			{
				type: "inner-tool-start",
				parentCallId: "parent-1",
				callId: "child-1",
				name: "fs.read",
				args: { path: "x.ts" },
			},
			ui,
		);

		state = dispatchTuiEvent(
			state,
			{
				type: "inner-tool-end",
				parentCallId: "parent-1",
				callId: "child-1",
			},
			ui,
		);

		const parent = state.activeCalls.get("parent-1");
		expect(parent?.children.has("child-1")).toBe(false);
		expect(ui.calls).toContain("unchild:parent-1->child-1");
	});

	it("orphaned inner-tool-start is ignored", () => {
		const ui = noopUi();
		let state = initialTuiState();

		state = dispatchTuiEvent(
			state,
			{
				type: "inner-tool-start",
				parentCallId: "nonexistent",
				callId: "child-1",
				name: "fs.read",
				args: {},
			},
			ui,
		);

		expect(state.activeCalls.size).toBe(0);
	});
});
