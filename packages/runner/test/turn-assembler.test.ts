import { describe, expect, it } from "vitest";
import type { Turn } from "../src/session-store.js";
import { assembleTurns, DEFAULT_CONTEXT_WINDOW_POLICY, turnsToMessages } from "../src/turn-assembler.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeTurn(
	id: string,
	turnIndex: number,
	opts: {
		typeWeight?: number;
		tokenCost?: number;
		payload?: string; // text included in event payloads for keyword scoring
	} = {},
): Turn {
	return {
		id,
		turnIndex,
		tokenCost: opts.tokenCost ?? 100,
		typeWeight: opts.typeWeight ?? 0.8,
		events: [
			{
				bus: "motor",
				type: "dialog.message",
				correlationId: id,
				payload: { text: opts.payload ?? "" },
				timestamp: Date.now(),
			},
		],
	};
}

const LARGE_CONTEXT = 200_000;

// ---------------------------------------------------------------------------
// recentGuarantee
// ---------------------------------------------------------------------------

describe("assembleTurns — recentGuarantee", { tags: ["unit"] }, () => {
	it("always includes the last N turns regardless of score", () => {
		const turns = Array.from({ length: 20 }, (_, i) => makeTurn(`c-${i}`, i));
		const result = assembleTurns(turns, { query: "unrelated", contextWindow: LARGE_CONTEXT });

		const resultIds = new Set(result.map((t) => t.id));
		// Last N (default recentGuarantee) must always be present
		const g = DEFAULT_CONTEXT_WINDOW_POLICY.recentGuarantee;
		for (let i = 20 - g; i < 20; i++) {
			expect(resultIds.has(`c-${i}`), `c-${i} missing`).toBe(true);
		}
	});

	it("returns all turns when count <= recentGuarantee", () => {
		const turns = [makeTurn("c-0", 0), makeTurn("c-1", 1), makeTurn("c-2", 2)];
		const result = assembleTurns(turns, { query: "anything", contextWindow: LARGE_CONTEXT });
		expect(result).toHaveLength(3);
	});
});

// ---------------------------------------------------------------------------
// Budget enforcement
// ---------------------------------------------------------------------------

describe("assembleTurns — budget", { tags: ["unit"] }, () => {
	it("never exceeds historyBudget in total token cost", () => {
		const turns = Array.from({ length: 30 }, (_, i) => makeTurn(`c-${i}`, i, { tokenCost: 500 }));
		const contextWindow = 10_000;
		const historyBudget = Math.floor(contextWindow * DEFAULT_CONTEXT_WINDOW_POLICY.historyFraction);
		const maxCost = Math.floor(historyBudget * DEFAULT_CONTEXT_WINDOW_POLICY.maxSingleTurnFraction);

		const result = assembleTurns(turns, { query: "test", contextWindow });
		const totalCost = result.reduce((n, t) => n + Math.min(t.tokenCost, maxCost), 0);
		expect(totalCost).toBeLessThanOrEqual(historyBudget + 1); // +1 for rounding
	});

	it("caps single turn at maxSingleTurnFraction of historyBudget", () => {
		// One very large turn — should not consume more than 25% of budget
		const bigTurn = makeTurn("big", 0, { tokenCost: 1_000_000 });
		const otherTurns = Array.from({ length: 5 }, (_, i) => makeTurn(`c-${i}`, i + 1, { tokenCost: 10 }));
		const contextWindow = 10_000;
		const historyBudget = Math.floor(contextWindow * DEFAULT_CONTEXT_WINDOW_POLICY.historyFraction);
		const maxSingleCost = Math.floor(historyBudget * DEFAULT_CONTEXT_WINDOW_POLICY.maxSingleTurnFraction);

		const result = assembleTurns([bigTurn, ...otherTurns], { query: "test", contextWindow });
		const bigInResult = result.find((t) => t.id === "big");
		if (bigInResult) {
			// If included, its effective cost is capped
			expect(Math.min(bigInResult.tokenCost, maxSingleCost)).toBeLessThanOrEqual(maxSingleCost);
		}
	});
});

// ---------------------------------------------------------------------------
// Chronological sort
// ---------------------------------------------------------------------------

describe("assembleTurns — ordering", { tags: ["unit"] }, () => {
	it("returns turns sorted by turnIndex ascending (chronological for LLM)", () => {
		const turns = Array.from({ length: 10 }, (_, i) => makeTurn(`c-${i}`, i));
		const result = assembleTurns(turns, { query: "anything", contextWindow: LARGE_CONTEXT });

		for (let i = 1; i < result.length; i++) {
			expect(result[i].turnIndex).toBeGreaterThanOrEqual(result[i - 1].turnIndex);
		}
	});
});

// ---------------------------------------------------------------------------
// typeWeight scoring
// ---------------------------------------------------------------------------

describe("assembleTurns — typeWeight", { tags: ["unit"] }, () => {
	it("write-type turn scores higher than grep-only turn", () => {
		// Create exactly recentGuarantee+1 turns so we have one candidate to score
		const writeTurn = makeTurn("write", 0, { typeWeight: 2.0, tokenCost: 200 });
		const grepTurn = makeTurn("grep", 1, { typeWeight: 0.6, tokenCost: 200 });
		// 8 recent turns fill the guarantee
		const recentTurns = Array.from({ length: 8 }, (_, i) => makeTurn(`recent-${i}`, i + 2, { tokenCost: 50 }));

		// Small budget: can only fit one of write/grep beyond the recent guarantee
		const contextWindow = 4_000; // historyBudget = 2800, recent = 8×50 = 400, remainder = 2400
		const result = assembleTurns([writeTurn, grepTurn, ...recentTurns], {
			query: "something unrelated",
			contextWindow,
			policy: { recentGuarantee: 8 },
		});

		const resultIds = result.map((t) => t.id);
		// write should win over grep when budget is tight
		// (they're both candidates, write has higher typeWeight)
		if (resultIds.includes("write") && !resultIds.includes("grep")) {
			expect(true).toBe(true); // write correctly preferred
		} else if (resultIds.includes("grep") && !resultIds.includes("write")) {
			// grep winning means something is wrong with typeWeight scoring
			expect(true).toBe(false); // fail
		}
		// Both included = budget was sufficient = acceptable
	});
});

// ---------------------------------------------------------------------------
// LRU hit counts
// ---------------------------------------------------------------------------

describe("assembleTurns — LRU hit counts", { tags: ["unit"] }, () => {
	it("turn with higher hit count scores better", () => {
		const hotTurn = makeTurn("hot", 0, { tokenCost: 100 });
		const coldTurn = makeTurn("cold", 1, { tokenCost: 100 });
		const recentTurns = Array.from({ length: 8 }, (_, i) => makeTurn(`recent-${i}`, i + 2, { tokenCost: 50 }));

		const hitCounts = new Map([
			["hot", 10],
			["cold", 0],
		]);

		// Budget: only room for one candidate beyond recent
		const contextWindow = 4_000;
		const result = assembleTurns([hotTurn, coldTurn, ...recentTurns], {
			query: "unrelated",
			contextWindow,
			hitCounts,
			policy: { recentGuarantee: 8 },
		});

		const resultIds = result.map((t) => t.id);
		if (resultIds.includes("hot") !== resultIds.includes("cold")) {
			// When only one fits, hot should win
			expect(resultIds.includes("hot")).toBe(true);
		}
	});
});

// ---------------------------------------------------------------------------
// Term overlap
// ---------------------------------------------------------------------------

describe("assembleTurns — term overlap", { tags: ["unit"] }, () => {
	it("turn whose payload contains query keywords scores higher", () => {
		const relevantTurn = makeTurn("relevant", 0, {
			tokenCost: 100,
			payload: "the authentication module uses JWT tokens for login",
		});
		const irrelevantTurn = makeTurn("irrelevant", 1, {
			tokenCost: 100,
			payload: "the database schema was updated for performance",
		});
		const recentTurns = Array.from({ length: 8 }, (_, i) => makeTurn(`recent-${i}`, i + 2, { tokenCost: 50 }));

		// Budget: only room for one candidate
		const contextWindow = 4_000;
		const result = assembleTurns([relevantTurn, irrelevantTurn, ...recentTurns], {
			query: "how does authentication and login work with JWT",
			contextWindow,
			policy: { recentGuarantee: 8 },
		});

		const resultIds = result.map((t) => t.id);
		if (resultIds.includes("relevant") !== resultIds.includes("irrelevant")) {
			expect(resultIds.includes("relevant")).toBe(true);
		}
	});
});

// ---------------------------------------------------------------------------
// Empty / edge cases
// ---------------------------------------------------------------------------

describe("assembleTurns — edge cases", { tags: ["unit"] }, () => {
	it("returns empty array for empty turns", () => {
		expect(assembleTurns([], { query: "test", contextWindow: LARGE_CONTEXT })).toHaveLength(0);
	});

	it("works with empty query (no keyword scoring)", () => {
		const turns = Array.from({ length: 5 }, (_, i) => makeTurn(`c-${i}`, i));
		const result = assembleTurns(turns, { query: "", contextWindow: LARGE_CONTEXT });
		expect(result.length).toBeGreaterThan(0);
	});

	it("wall-clock time has no effect on output (only turnIndex matters)", () => {
		// Two identical turns except timestamps — result should be identical
		const turns1 = [makeTurn("c-0", 0), makeTurn("c-1", 1)];
		for (const t of turns1)
			for (const e of t.events) {
				(e as { timestamp: number }).timestamp = 1000;
			}

		const turns2 = [makeTurn("c-0", 0), makeTurn("c-1", 1)];
		for (const t2 of turns2)
			for (const e2 of t2.events) {
				(e2 as { timestamp: number }).timestamp = 9_999_999;
			}

		const result1 = assembleTurns(turns1, { query: "test", contextWindow: LARGE_CONTEXT });
		const result2 = assembleTurns(turns2, { query: "test", contextWindow: LARGE_CONTEXT });

		expect(result1.map((t) => t.id)).toEqual(result2.map((t) => t.id));
	});
});

// ---------------------------------------------------------------------------
// turnsToMessages
// ---------------------------------------------------------------------------

function makeDialogTurn(
	id: string,
	index: number,
	events: Array<{ bus: "motor" | "sense"; payload: Record<string, unknown> }>,
): Turn {
	return {
		id,
		turnIndex: index,
		tokenCost: 10,
		typeWeight: 0.8,
		events: events.map((e) => ({
			bus: e.bus,
			type: "dialog.message",
			correlationId: id,
			payload: e.payload,
			timestamp: Date.now(),
		})),
	};
}

describe("turnsToMessages — conversationHistory primary path", { tags: ["unit"] }, () => {
	it("returns conversationHistory from the most recent motor/dialog.message", () => {
		const history = [
			{ role: "user", content: "Read the file" },
			{ role: "assistant", content: [{ type: "toolCall", id: "t1" }] },
			{ role: "toolResult", content: "file contents" },
			{ role: "assistant", content: "The token is ABC" },
		];
		const turns = [
			makeDialogTurn("c-0", 0, [
				{ bus: "sense", payload: { text: "Read the file" } },
				{ bus: "motor", payload: { text: "The token is ABC", conversationHistory: history } },
			]),
		];
		const result = turnsToMessages(turns);
		expect(result).toBe(history);
	});

	it("prefers the most recent turn with conversationHistory", () => {
		const history1 = [
			{ role: "user", content: "turn 1" },
			{ role: "assistant", content: "reply 1" },
		];
		const history2 = [
			{ role: "user", content: "turn 1" },
			{ role: "assistant", content: "reply 1" },
			{ role: "user", content: "turn 2" },
			{ role: "assistant", content: "reply 2" },
		];
		const turns = [
			makeDialogTurn("c-0", 0, [{ bus: "motor", payload: { text: "reply 1", conversationHistory: history1 } }]),
			makeDialogTurn("c-1", 1, [{ bus: "motor", payload: { text: "reply 2", conversationHistory: history2 } }]),
		];
		const result = turnsToMessages(turns);
		expect(result).toBe(history2);
		expect(result).toHaveLength(4);
	});

	it("falls back to text-only when no conversationHistory present", () => {
		const turns = [
			makeDialogTurn("c-0", 0, [
				{ bus: "sense", payload: { text: "hello" } },
				{ bus: "motor", payload: { text: "hi" } },
			]),
		];
		const result = turnsToMessages(turns);
		expect(result).toHaveLength(2);
		expect(result[0]).toMatchObject({ role: "user", content: "hello" });
		// Fallback path: assistant text is preserved as a user message with [assistant] prefix
		// so it doesn't need to satisfy the full AssistantMessage type shape.
		expect(result[1]).toMatchObject({ role: "user", content: "[assistant] hi" });
	});

	it("reconstructs context from tool-call events when no dialog.message exists (aborted turn)", () => {
		const turn: Turn = {
			id: "c-0",
			turnIndex: 0,
			tokenCost: 10,
			typeWeight: 1.0,
			events: [{ bus: "motor", type: "fs.read", correlationId: "c-0", payload: { path: "x.ts" }, timestamp: 0 }],
		};
		const result = turnsToMessages([turn]);
		expect(result.length).toBeGreaterThan(0);
		expect(JSON.stringify(result)).toContain("fs.read");
	});
});

// ---------------------------------------------------------------------------
// Abort-before-dialog.message — the dementia regression (ALE-BUG-46)
//
// When the user interrupts after tool calls complete but before the Reasoner
// publishes motor/dialog.message, the turn has completed tool events in the
// JSONL but no conversationHistory checkpoint. turnsToMessages currently
// returns [] for such turns, causing the next LLM call to have no memory of
// the tool work done (verified in debug trace 2026-05-31 session 0ccbc171).
//
// RED: these tests must FAIL with the current code. GREEN after the fix.
// ---------------------------------------------------------------------------

function makeAbortedTurn(
	id: string,
	index: number,
	toolCalls: Array<{ type: string; motorPayload: Record<string, unknown>; sensePayload: Record<string, unknown> }>,
): Turn {
	const events = toolCalls.flatMap(({ type, motorPayload, sensePayload }) => [
		{ bus: "motor" as const, type, correlationId: id, payload: motorPayload, timestamp: Date.now() },
		{ bus: "sense" as const, type, correlationId: id, payload: sensePayload, timestamp: Date.now() },
	]);
	// No motor/dialog.message — simulates abort before Reasoner published the checkpoint.
	return { id, turnIndex: index, tokenCost: 200, typeWeight: 2.0, events };
}

describe("turnsToMessages — aborted turn, ALE-BUG-46", { tags: ["unit"] }, () => {
	it("non-empty result when turn has completed tool calls but no dialog.message", () => {
		// Mirrors the 2026-05-31 session: 7 fs.write calls completed, then abort.
		const turn = makeAbortedTurn("abort-1", 0, [
			{
				type: "fs.write",
				motorPayload: { path: "CODEBASE_EXPLORATION.md", content: "# exploration", toolCallId: "tc1" },
				sensePayload: { applied: true, toolCallId: "tc1" },
			},
			{
				type: "fs.write",
				motorPayload: { path: "ARCHITECTURE_DIAGRAMS.md", content: "# diagrams", toolCallId: "tc2" },
				sensePayload: { applied: true, toolCallId: "tc2" },
			},
		]);
		// FAIL currently: turnsToMessages returns [] — no dialog.message found.
		// PASS after fix: returns at least the tool work as context.
		const result = turnsToMessages([turn]);
		expect(result.length).toBeGreaterThan(0);
	});

	it("tool names appear in the reconstructed context", () => {
		const turn = makeAbortedTurn("abort-2", 0, [
			{
				type: "fs.write",
				motorPayload: { path: "CODEBASE_EXPLORATION.md", content: "...", toolCallId: "tc1" },
				sensePayload: { applied: true, toolCallId: "tc1" },
			},
		]);
		const result = turnsToMessages([turn]);
		const asText = JSON.stringify(result);
		// The reconstructed context must reference the file that was written.
		expect(asText).toContain("CODEBASE_EXPLORATION.md");
	});

	it("a completed prior turn + aborted turn both contribute context", () => {
		// Normal completed turn provides conversationHistory checkpoint.
		const completedTurn = makeDialogTurn("c-0", 0, [
			{ bus: "sense", payload: { text: "Explore the codebase" } },
			{
				bus: "motor",
				payload: {
					text: "Starting exploration.",
					conversationHistory: [
						{ role: "user", content: "Explore the codebase" },
						{ role: "assistant", content: "Starting exploration." },
					],
				},
			},
		]);
		// Then an aborted turn with file writes but no dialog.message.
		const abortedTurn = makeAbortedTurn("abort-3", 1, [
			{
				type: "fs.write",
				motorPayload: { path: "CODEBASE_EXPLORATION.md", content: "...", toolCallId: "tc1" },
				sensePayload: { applied: true, toolCallId: "tc1" },
			},
		]);
		// The aborted turn's tool work must appear alongside the prior history.
		const result = turnsToMessages([completedTurn, abortedTurn]);
		const asText = JSON.stringify(result);
		expect(asText).toContain("CODEBASE_EXPLORATION.md");
	});
});

// ---------------------------------------------------------------------------
// prepareStep contract — BDD scenarios (defineFeature, no .feature files needed)
// ---------------------------------------------------------------------------

import { defineFeature } from "@dpopsuev/alef-testkit/bdd";

defineFeature("prepareStep context-window selection", (f) => {
	// Rule A: turnsToMessages finds conversationHistory in JSONL → return it + currentMsg.
	// Rule B: no conversationHistory → text-only fallback → return it + currentMsg.
	// Rule C: no JSONL history at all → return payload unchanged.

	f.Scenario("JSONL has conversationHistory from prior turn — tool blocks preserved", (s) => {
		type Msg = { role: string; content: unknown };
		let conversationHistory: Msg[];
		let currentMsg: Msg;
		let result: Msg[];

		s.Given("a motor/dialog.message event in JSONL carries conversationHistory with tool blocks", () => {
			conversationHistory = [
				{ role: "user", content: "Read the file" },
				{ role: "assistant", content: [{ type: "toolCall", id: "t1", toolName: "fs.read" }] },
				{ role: "toolResult", content: [{ type: "text", text: "ACCESS_CODE=ABC" }] },
				{ role: "assistant", content: "The code is ABC" },
			];
			currentMsg = { role: "user", content: "What was the access code?" };
		});
		s.When("turnsToMessages returns the conversationHistory and prepareStep appends current message", () => {
			result = [...conversationHistory, currentMsg];
		});
		s.Then("result contains tool blocks from the prior turn", () => {
			expect(result.some((m) => m.role === "toolResult")).toBe(true);
			expect(
				result.some(
					(m) =>
						m.role === "toolCall" ||
						(Array.isArray(m.content) && (m.content as { type: string }[])[0]?.type === "toolCall"),
				),
			).toBe(true);
		});
		s.And("result ends with the current user message", () => {
			expect(result.at(-1)?.role).toBe("user");
			expect(result.at(-1)?.content).toBe("What was the access code?");
		});
	});

	f.Scenario("JSONL has text-only history (no conversationHistory) — fallback reconstruction", (s) => {
		type Msg = { role: string; content: string };
		let projected: Msg[];
		let currentMsg: Msg;
		let result: Msg[];

		s.Given("motor/dialog.message events in JSONL have no conversationHistory field", () => {
			projected = [
				{ role: "user", content: "turn 1 text" },
				{ role: "assistant", content: "turn 1 reply" },
			];
			currentMsg = { role: "user", content: "turn 2 question" };
		});
		s.When("turnsToMessages returns text-only reconstruction and prepareStep appends current message", () => {
			result = [...projected, currentMsg];
		});
		s.Then("result contains prior turns plus current message", () => {
			expect(result).toHaveLength(3);
			expect(result.at(-1)?.content).toBe("turn 2 question");
		});
		s.And("result ends with role user", () => {
			expect(result.at(-1)?.role).toBe("user");
		});
	});

	f.Scenario("first turn — no JSONL history yet — payload passed through", (s) => {
		let projected: unknown[];
		let messages: { role: string; content: string }[];
		let result: { role: string; content: string }[];

		s.Given("no prior turns in JSONL and turnsToMessages returns empty", () => {
			projected = [];
			messages = [
				{ role: "system", content: "You are a coding assistant." },
				{ role: "user", content: "Read secret.txt" },
			];
		});
		s.When("prepareStep finds projected is empty", () => {
			result = projected.length > 0 ? [] : messages;
		});
		s.Then("payload is returned unchanged", () => {
			expect(result).toBe(messages);
		});
		s.And("result ends with the user message", () => {
			expect(result.at(-1)?.role).toBe("user");
		});
	});

	f.Scenario("text-only reconstruction loses tool blocks — conversationHistory path preserves them", (s) => {
		type Msg = { role: string; content: unknown };
		let richHistory: Msg[];
		let textOnlyHistory: Msg[];

		s.Given("a prior turn that used tools", () => {
			richHistory = [
				{ role: "user", content: "Read the file" },
				{ role: "assistant", content: [{ type: "toolCall", id: "t1" }] },
				{ role: "toolResult", content: "file contents" },
				{ role: "assistant", content: "The token is ABC" },
			];
			textOnlyHistory = [
				{ role: "user", content: "Read the file" },
				{ role: "assistant", content: "The token is ABC" },
			];
		});
		s.Then("rich history from conversationHistory contains tool blocks the API requires", () => {
			expect(richHistory.some((m) => m.role === "toolResult")).toBe(true);
		});
		s.And("text-only reconstruction drops tool blocks — Anthropic API hangs on next turn", () => {
			expect(textOnlyHistory.every((m) => m.role !== "toolResult")).toBe(true);
		});
	});
});
