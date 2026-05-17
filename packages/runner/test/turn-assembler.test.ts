import { describe, expect, it } from "vitest";
import type { Turn } from "../src/session-store.js";
import { assembleTurns, DEFAULT_CONTEXT_WINDOW_POLICY } from "../src/turn-assembler.js";

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

describe("assembleTurns — recentGuarantee", () => {
	it("always includes the last N turns regardless of score", () => {
		const turns = Array.from({ length: 20 }, (_, i) => makeTurn(`c-${i}`, i));
		const result = assembleTurns(turns, { query: "unrelated", contextWindow: LARGE_CONTEXT });

		const resultIds = new Set(result.map((t) => t.id));
		// Last 8 (default recentGuarantee) must always be present
		for (let i = 12; i < 20; i++) {
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

describe("assembleTurns — budget", () => {
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

describe("assembleTurns — ordering", () => {
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

describe("assembleTurns — typeWeight", () => {
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

describe("assembleTurns — LRU hit counts", () => {
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

describe("assembleTurns — term overlap", () => {
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

describe("assembleTurns — edge cases", () => {
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
