/**
 * computeDispatch -- pure function tests.
 *
 * Tests the event dispatch logic without any TUI components, terminal,
 * or rendering. Only state transitions and RenderIntent[] output.
 */

import { describe, expect, it } from "vitest";
import { computeDispatch, type DispatchContext } from "../src/client/events.js";
import type { RenderIntent } from "../src/client/render-intent.js";
import { initialDispatchState } from "../src/client/state.js";

const W = { ansi16: 37 };

function ctx(overrides: Partial<DispatchContext> = {}): DispatchContext {
	return {
		t: {
			agentFg: W,
			accentFg: W,
			okFg: W,
			errFg: W,
			warnFg: W,
			mutedFg: W,
			primaryFg: W,
			secondaryFg: W,
			brightFg: W,
			userFg: W,
			userBg: W,
			agentBg: W,
		} as DispatchContext["t"],
		hideThinking: false,
		...overrides,
	};
}

function intentKinds(intents: RenderIntent[]): string[] {
	return intents.map((i) => i.kind);
}

describe("computeDispatch (pure)", { tags: ["unit"] }, () => {
	it("chunk event produces reply-chunk + pulse intents", () => {
		const state = initialDispatchState();
		const result = computeDispatch(state, { type: "chunk", text: "hello" }, ctx());

		expect(intentKinds(result.intents)).toContain("pulse");
		expect(intentKinds(result.intents)).toContain("reply-chunk");

		const chunk = result.intents.find((i) => i.kind === "reply-chunk");
		expect(chunk).toBeDefined();
		if (chunk?.kind === "reply-chunk") {
			expect(chunk.text).toBe("hello");
		}
	});

	it("chunk event shows pending footer on first chunk", () => {
		const state = initialDispatchState();
		const result = computeDispatch(state, { type: "chunk", text: "x" }, ctx());

		expect(intentKinds(result.intents)).toContain("show-pending-footer");
		expect(result.state.pendingFooterShown).toBe(true);
	});

	it("chunk event does not show pending footer if already shown", () => {
		const state = { ...initialDispatchState(), pendingFooterShown: true };
		const result = computeDispatch(state, { type: "chunk", text: "x" }, ctx());

		expect(intentKinds(result.intents)).not.toContain("show-pending-footer");
	});

	it("thinking event produces thinking-chunk + pulse", () => {
		const state = initialDispatchState();
		const result = computeDispatch(state, { type: "thinking", text: "hmm" }, ctx());

		expect(intentKinds(result.intents)).toContain("pulse");
		expect(intentKinds(result.intents)).toContain("thinking-chunk");
	});

	it("tool-start produces show-in-flight-call + pulse", () => {
		const state = initialDispatchState();
		const result = computeDispatch(
			state,
			{
				type: "tool-start",
				callId: "c1",
				name: "fs.read",
				args: { path: "README.md" },
			},
			ctx(),
		);

		expect(intentKinds(result.intents)).toContain("pulse");
		expect(intentKinds(result.intents)).toContain("show-in-flight-call");
		expect(result.state.activeCalls.has("c1")).toBe(true);
	});

	it("tool-end produces remove-in-flight-call + append-tool-result", () => {
		const state = {
			...initialDispatchState(),
			activeCalls: new Map([
				["c1", { name: "fs.edit", keyArg: "f.ts", args: { path: "f.ts" }, children: new Map(), depth: 0 }],
			]),
			batchStartedAt: Date.now(),
			batchCallCount: 1,
		};

		const result = computeDispatch(
			state,
			{
				type: "tool-end",
				callId: "c1",
				elapsedMs: 100,
				ok: true,
				display: "edit f.ts\n-old\n+new",
				displayKind: "text/x-diff",
			},
			ctx(),
		);

		expect(intentKinds(result.intents)).toContain("remove-in-flight-call");
		expect(intentKinds(result.intents)).toContain("append-tool-result");

		const toolResult = result.intents.find((i) => i.kind === "append-tool-result");
		if (toolResult?.kind === "append-tool-result") {
			expect(toolResult.name).toBe("fs.edit");
			expect(toolResult.displayKind).toBe("text/x-diff");
		}

		expect(result.state.activeCalls.size).toBe(0);
	});

	it("turn-complete resets UI components and stops thinking", () => {
		const state = { ...initialDispatchState(), pendingFooterShown: true };
		const result = computeDispatch(state, { type: "turn-complete", reply: "done" }, ctx());

		const kinds = intentKinds(result.intents);
		expect(kinds).toContain("flush-reply-tw");
		expect(kinds).toContain("flush-thinking-tw");
		expect(kinds).toContain("reset-reply-block");
		expect(kinds).toContain("stop-thinking");
		expect(kinds).toContain("hide-pending-footer");
		expect(kinds).toContain("on-turn-complete");
		expect(result.state.pendingFooterShown).toBe(false);
	});

	it("turn-error produces error notice and clears active calls", () => {
		const state = {
			...initialDispatchState(),
			activeCalls: new Map([["c1", { name: "fs.read", keyArg: "x", args: {}, children: new Map(), depth: 0 }]]),
		};
		const result = computeDispatch(
			state,
			{
				type: "turn.error",
				error: new Error("boom"),
				aborted: false,
			},
			ctx(),
		);

		const kinds = intentKinds(result.intents);
		expect(kinds).toContain("stop-thinking");
		expect(kinds).toContain("append-notice");
		expect(kinds).toContain("remove-in-flight-call");
		expect(result.state.activeCalls.size).toBe(0);
	});

	it("thinking.toggle produces set-hide-thinking + notice", () => {
		const state = initialDispatchState();
		const result = computeDispatch(state, { type: "thinking.toggle" }, ctx({ hideThinking: false }));

		const kinds = intentKinds(result.intents);
		expect(kinds).toContain("set-hide-thinking");
		expect(kinds).toContain("append-notice");

		const notice = result.intents.find((i) => i.kind === "append-notice");
		if (notice?.kind === "append-notice") {
			expect(notice.text).toContain("hidden");
		}
	});

	it("state-changed is a no-op", () => {
		const state = initialDispatchState();
		const result = computeDispatch(state, { type: "state-changed", contextWindow: 128000 } as any, ctx());

		expect(result.intents).toHaveLength(0);
		expect(result.state).toBe(state);
	});

	it("tool-chunk updates call chunks and produces pulse + update-in-flight-call-chunk", () => {
		const state = {
			...initialDispatchState(),
			activeCalls: new Map([["c1", { name: "fs.read", keyArg: "x", args: {}, children: new Map(), depth: 0 }]]),
		};
		const result = computeDispatch(
			state,
			{
				type: "tool-chunk",
				callId: "c1",
				text: "partial output",
			},
			ctx(),
		);

		expect(intentKinds(result.intents)).toContain("pulse");
		expect(intentKinds(result.intents)).toContain("update-in-flight-call-chunk");
		expect(result.state.callChunks.get("c1")).toContain("partial output");
	});

	it("turn-error with aborted=true does not add error notice", () => {
		const state = initialDispatchState();
		const result = computeDispatch(
			state,
			{
				type: "turn.error",
				error: new Error("cancelled"),
				aborted: true,
			},
			ctx(),
		);

		const notices = result.intents.filter((i) => i.kind === "append-notice");
		expect(notices).toHaveLength(0);
	});

	it("discussion-changed produces set-topic-label", () => {
		const state = initialDispatchState();
		const result = computeDispatch(
			state,
			{
				type: "discussion-changed",
				discussion: {
					active: { forumId: "f", topicId: "t", topicTitle: "New topic" },
					home: { forumId: "f", topicId: "t" },
				},
			} as any,
			ctx(),
		);

		const label = result.intents.find((i) => i.kind === "set-topic-label");
		expect(label).toBeDefined();
		if (label?.kind === "set-topic-label") {
			expect(label.text).toBe("New topic");
		}
	});
});
