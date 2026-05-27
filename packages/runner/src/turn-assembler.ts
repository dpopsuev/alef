/**
 * TurnAssembler — scored per-turn context window assembly from the event log.
 *
 * Pure function. No organ. No bus event. No LLM call.
 * Called from "Reasoner" (or directly from DialogOrgan.buildPayload).
 *
 * Algorithm:
 *   1. Always include last recentGuarantee turns (recency guarantee)
 *   2. Score remaining turns by: termOverlap + LRU hit frequency + ordinal recency
 *   3. Greedily fill budget with highest score/tokenCost turns
 *   4. Cap any single turn at maxSingleTurnFraction of history budget
 *   5. Re-sort included turns chronologically for the LLM
 *
 * Key design decisions (ALE-SPC-15):
 *   - Turn index (ordinal position) is recency, NOT wall-clock time
 *   - Write/edit turns score 2× via typeWeight — never evicted lightly
 *   - Hit counts from window.assembled records — durable LRU signal
 *   - No embeddings required in Phase 1 — keyword overlap only
 *
 * Ref: ALE-SPC-15, ALE-TSK-179
 */

import type { AssistantMessage, Message, UserMessage } from "@dpopsuev/alef-organ-llm";
import type { Turn } from "./session-store.js";

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

export interface ContextWindowPolicy {
	/**
	 * Fraction of model.contextWindow allocated to history.
	 * Remainder reserved for system prompt, tools, current message, LLM reply.
	 * Default: 0.70
	 */
	historyFraction: number;

	/**
	 * No single turn may consume more than this fraction of historyBudget.
	 * Prevents one large file read from crowding out all other context.
	 * Default: 0.25
	 */
	maxSingleTurnFraction: number;

	/**
	 * Always include the last N turns regardless of score.
	 * Guarantees the LLM sees the most recent conversation thread.
	 * Default: 8
	 */
	recentGuarantee: number;

	/** Weight for keyword overlap with current query. Default: 0.40 */
	termOverlapWeight: number;

	/** Weight for LRU hit frequency (normalized). Default: 0.30 */
	hitFrequencyWeight: number;

	/**
	 * Weight for ordinal recency (turn index, not wall-clock). Default: 0.30
	 * Wall-clock time is NOT used — it's a false metric for semantic relevance.
	 */
	recencyWeight: number;
}

export const DEFAULT_CONTEXT_WINDOW_POLICY: ContextWindowPolicy = {
	historyFraction: 0.7,
	maxSingleTurnFraction: 0.25,
	recentGuarantee: 4,
	termOverlapWeight: 0.4,
	hitFrequencyWeight: 0.3,
	recencyWeight: 0.3,
};

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

/**
 * Term overlap: fraction of query tokens found in any payload field of the turn.
 * Simple keyword matching — no embeddings required.
 */
function termOverlap(turn: Turn, queryTokens: string[]): number {
	if (queryTokens.length === 0) return 0;
	const haystack = turn.events
		.flatMap((e) => Object.values(e.payload))
		.filter((v): v is string => typeof v === "string")
		.join(" ")
		.toLowerCase();

	let hits = 0;
	for (const token of queryTokens) {
		if (haystack.includes(token)) hits++;
	}
	return hits / queryTokens.length;
}

function normalize(value: number, max: number): number {
	if (max <= 0) return 0;
	return Math.min(1, value / max);
}

function scoreTurn(
	turn: Turn,
	queryTokens: string[],
	hitCounts: Map<string, number>,
	maxHitCount: number,
	policy: ContextWindowPolicy,
): number {
	const overlap = termOverlap(turn, queryTokens);
	const hitFreq = normalize(hitCounts.get(turn.id) ?? 0, maxHitCount);
	const recency = turn.turnIndex; // raw index — normalized below per call

	return (
		policy.termOverlapWeight * overlap +
		policy.hitFrequencyWeight * hitFreq +
		policy.recencyWeight * recency + // normalized by caller
		turn.typeWeight // additive bonus, not multiplied
	);
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.split(/\W+/)
		.filter((t) => t.length > 2); // skip stop words via length
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

export interface AssembleOptions {
	/** Current user query — used for keyword scoring. */
	query: string;
	/** Total model context window in tokens. historyBudget = contextWindow * historyFraction. */
	contextWindow: number;
	/** Policy overrides. Merged with DEFAULT_CONTEXT_WINDOW_POLICY. */
	policy?: Partial<ContextWindowPolicy>;
	/** Hit counts from SessionStore.hitCounts() for LRU frequency scoring. */
	hitCounts?: Map<string, number>;
}

/**
 * Select the most relevant turns from the event log to include in the context window.
 * Returns turns sorted chronologically (by turnIndex ascending) for the LLM.
 */
export function assembleTurns(turns: Turn[], opts: AssembleOptions): Turn[] {
	if (turns.length === 0) return [];

	const policy = { ...DEFAULT_CONTEXT_WINDOW_POLICY, ...opts.policy };
	const hitCounts = opts.hitCounts ?? new Map<string, number>();
	const historyBudget = Math.floor(opts.contextWindow * policy.historyFraction);
	const maxSingleTurnCost = Math.floor(historyBudget * policy.maxSingleTurnFraction);

	const recentCount = Math.min(policy.recentGuarantee, turns.length);
	const recentTurns = turns.slice(-recentCount);
	const recentIds = new Set(recentTurns.map((t) => t.id));
	const candidateTurns = turns.slice(0, -recentCount);

	let remaining = historyBudget - recentTurns.reduce((n, t) => n + Math.min(t.tokenCost, maxSingleTurnCost), 0);
	const included: Turn[] = [...recentTurns];

	if (remaining <= 0 || candidateTurns.length === 0) {
		return recentTurns.slice().sort((a, b) => a.turnIndex - b.turnIndex);
	}

	const queryTokens = tokenize(opts.query);
	const maxHitCount = Math.max(1, ...Array.from(hitCounts.values()));
	const maxTurnIndex = Math.max(1, turns.at(-1)?.turnIndex ?? 1);

	const scored = candidateTurns.map((turn) => {
		const rawScore = scoreTurn(turn, queryTokens, hitCounts, maxHitCount, {
			...policy,
			// Normalize recencyWeight component by maxTurnIndex so it stays in 0–1 range
			recencyWeight: policy.recencyWeight * (turn.turnIndex / maxTurnIndex),
		});
		const cost = Math.min(turn.tokenCost, maxSingleTurnCost);
		return { turn, score: rawScore, cost, evictionPriority: cost > 0 ? rawScore / cost : 0 };
	});

	scored.sort((a, b) => b.evictionPriority - a.evictionPriority);

	for (const { turn, cost } of scored) {
		if (cost > remaining) continue; // doesn't fit — skip (don't evict others for it)
		if (recentIds.has(turn.id)) continue; // already in recent
		included.push(turn);
		remaining -= cost;
		if (remaining <= 0) break;
	}

	return included.sort((a, b) => a.turnIndex - b.turnIndex);
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

/**
 * @deprecated Use Message from @dpopsuev/alef-ai directly.
 * Kept as an alias for callsites that have not been updated yet.
 */
export type ConversationMessage = Pick<UserMessage | AssistantMessage, "role" | "content">;

/**
 * Project selected turns into a message array for Reasoner payload.
 *
 * Primary path: find the most recent motor/dialog.message event that carries a
 * conversationHistory array (published by Reasoner after each quiescent turn).
 * That array already contains role+content blocks including tool_use and
 * tool_result — use it directly. This is durable across runner restarts because
 * the value is stored in the JSONL by SessionLog.
 *
 * Fallback: text-only reconstruction from dialog.message events (ScriptedReasoner,
 * first turn, or any organ that does not publish conversationHistory).
 */
/**
 * Project selected turns into a Message array for Reasoner.
 *
 * Primary path: find the most recent motor/dialog.message that carries
 * conversationHistory (published by Reasoner). That array is already a
 * proper Message[] — use it directly.
 *
 * Fallback: text-only reconstruction from dialog.message events.
 */
export function turnsToMessages(turns: Turn[]): Message[] {
	for (let i = turns.length - 1; i >= 0; i--) {
		const turn = turns[i];
		for (let j = turn.events.length - 1; j >= 0; j--) {
			const event = turn.events[j];
			if (event.bus !== "motor" || event.type !== "dialog.message") continue;
			const hist = event.payload.conversationHistory;
			if (Array.isArray(hist) && hist.length > 0) {
				// Reasoner stores properly typed Message objects in conversationHistory.
				return hist as Message[];
			}
		}
	}

	// Fallback: reconstruct from raw dialog.message events.
	const now = Date.now();
	const messages: Message[] = [];
	for (const turn of turns) {
		for (const event of turn.events) {
			if (event.type !== "dialog.message") continue;
			const text = typeof event.payload.text === "string" ? event.payload.text : "";
			if (!text) continue;
			if (event.bus === "sense") {
				messages.push({ role: "user", content: text, timestamp: now });
			} else if (event.bus === "motor") {
				// Simple text-only assistant message. Real assistant messages come from
				// the conversationHistory primary path above.
				messages.push({ role: "user", content: `[assistant] ${text}`, timestamp: now });
			}
		}
	}
	return messages;
}
