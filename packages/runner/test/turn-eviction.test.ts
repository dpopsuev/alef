/**
 * Eviction proof test — ALE-TSK-237.
 *
 * Proves that when a session exceeds the context budget, assembleTurns()
 * correctly evicts old irrelevant turns while preserving recent turns and
 * a keyword-relevant old turn.
 *
 * No real LLM. All turns are synthetic JSONL records appended directly.
 *
 * Budget math (controlled):
 *   contextWindow      = 4 000 tokens
 *   historyBudget      = 4 000 × 0.70 = 2 800 tokens
 *   maxSingleTurnCost  = 2 800 × 0.25 =   700 tokens
 *   recentGuarantee    = 4 (overridden from default 8)
 *   each turn cost     = 400 tokens (via usage.totalTokens anchor)
 *
 *   recent 4 × 400 = 1 600 → remaining = 2 800 − 1 600 = 1 200
 *   candidates: 1 relevant + 9 irrelevant = 10 turns × 400
 *   budget fits: ⌊1 200 / 400⌋ = 3 candidates → 7 evicted
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionStore, type StorageRecord } from "../src/session-store.js";
import { assembleTurns, DEFAULT_CONTEXT_WINDOW_POLICY } from "../src/turn-assembler.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONTEXT_WINDOW = 4_000;
const HISTORY_BUDGET = Math.floor(CONTEXT_WINDOW * DEFAULT_CONTEXT_WINDOW_POLICY.historyFraction);
const COST_PER_TURN = 400; // via usage.totalTokens anchor
const RECENT_GUARANTEE = 4;
const KEYWORD = "jwt_authentication_token"; // unique — won't appear in irrelevant payloads

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];
afterEach(() => {
	for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmpCwd(): string {
	const d = mkdtempSync(join(tmpdir(), "alef-evict-"));
	tempDirs.push(d);
	return d;
}

function motorDialogRecord(correlationId: string, text: string, totalTokens: number): StorageRecord {
	return {
		bus: "motor",
		type: "dialog.message",
		correlationId,
		payload: {
			text,
			conversationHistory: [
				{ role: "user", content: text },
				{ role: "assistant", content: `reply to: ${text}` },
			],
			// Usage anchor — SessionStore.turns() will use this as tokenCost.
			usage: { input: totalTokens - 50, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens },
		},
		timestamp: Date.now(),
	};
}

function senseDialogRecord(correlationId: string, text: string): StorageRecord {
	return {
		bus: "sense",
		type: "dialog.message",
		correlationId,
		payload: { text },
		timestamp: Date.now(),
	};
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe("assembleTurns — eviction proof", () => {
	it("evicts old irrelevant turns when session exceeds budget", async () => {
		const cwd = tmpCwd();
		const store = await SessionStore.create(cwd);

		// 9 old irrelevant turns (no keyword match)
		for (let i = 0; i < 9; i++) {
			const id = `old-irr-${i}`;
			await store.append(senseDialogRecord(id, `user message about unrelated topic ${i}`));
			await store.append(motorDialogRecord(id, `assistant reply about unrelated topic ${i}`, COST_PER_TURN));
		}

		// 1 old relevant turn (contains the keyword the query will use)
		const relevantId = "old-relevant";
		await store.append(senseDialogRecord(relevantId, `how does ${KEYWORD} work?`));
		await store.append(motorDialogRecord(relevantId, `${KEYWORD} is used for authentication`, COST_PER_TURN));

		// 4 recent turns (covered by recentGuarantee)
		for (let i = 0; i < RECENT_GUARANTEE; i++) {
			const id = `recent-${i}`;
			await store.append(senseDialogRecord(id, `recent user message ${i}`));
			await store.append(motorDialogRecord(id, `recent assistant reply ${i}`, COST_PER_TURN));
		}

		const turns = await store.turns();

		// Verify usage anchor was applied — each turn should cost exactly COST_PER_TURN
		for (const t of turns) {
			expect(t.tokenCost).toBe(COST_PER_TURN);
		}

		// Total turns: 9 irrelevant + 1 relevant + 4 recent = 14
		expect(turns).toHaveLength(14);

		// -----------------------------------------------------------------------
		// Assemble with small budget and tight recentGuarantee
		// -----------------------------------------------------------------------

		const selected = assembleTurns(turns, {
			query: KEYWORD, // keywords match the relevant old turn
			contextWindow: CONTEXT_WINDOW,
			policy: { recentGuarantee: RECENT_GUARANTEE },
		});

		const selectedIds = new Set(selected.map((t) => t.id));

		// 1. Result is shorter than total turns — eviction happened
		expect(selected.length).toBeLessThan(turns.length);

		// 2. All 4 recent turns survive (recentGuarantee)
		for (let i = 0; i < RECENT_GUARANTEE; i++) {
			expect(selectedIds.has(`recent-${i}`), `recent-${i} must survive`).toBe(true);
		}

		// 3. The keyword-relevant old turn survives
		expect(selectedIds.has("old-relevant"), "relevant old turn must survive").toBe(true);

		// 4. At least some old irrelevant turns are evicted
		const survivingIrrelevant = Array.from({ length: 9 }, (_, i) => `old-irr-${i}`).filter((id) =>
			selectedIds.has(id),
		);
		expect(survivingIrrelevant.length).toBeLessThan(9);

		// 5. Total token cost does not exceed historyBudget
		const totalCost = selected.reduce(
			(n, t) =>
				n + Math.min(t.tokenCost, Math.floor(HISTORY_BUDGET * DEFAULT_CONTEXT_WINDOW_POLICY.maxSingleTurnFraction)),
			0,
		);
		expect(totalCost).toBeLessThanOrEqual(HISTORY_BUDGET);

		// 6. Output is sorted chronologically (ascending turnIndex)
		for (let i = 1; i < selected.length; i++) {
			expect(selected[i].turnIndex).toBeGreaterThanOrEqual(selected[i - 1].turnIndex);
		}
	});

	it("preserves all turns when budget is large enough", async () => {
		const cwd = tmpCwd();
		const store = await SessionStore.create(cwd);

		for (let i = 0; i < 5; i++) {
			const id = `turn-${i}`;
			await store.append(senseDialogRecord(id, `message ${i}`));
			await store.append(motorDialogRecord(id, `reply ${i}`, COST_PER_TURN));
		}

		const turns = await store.turns();
		const selected = assembleTurns(turns, { query: "anything", contextWindow: 200_000 });

		// With a huge budget nothing should be evicted
		expect(selected).toHaveLength(5);
	});
});
